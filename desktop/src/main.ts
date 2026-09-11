import { app, BrowserWindow } from "electron";
import * as path from "path";
import { loadConfig, type ApiEnv } from "./config";
import { MAX_PORT_ATTEMPTS, choosePort, isAddrInUse } from "./port";
import {
  PROBE_TIMEOUT_MS,
  READY_INTERVAL_MS,
  READY_TIMEOUT_MS,
  probeHealth,
  waitForReady,
} from "./readiness";
import { launchDev, launchPackaged, type ApiHandle } from "./api-process";
import { launchVite } from "./vite-process";
import { lastMeaningfulLine, showStatus } from "./shell-window";
import { applyNavigationBoundary, applyPermissionBoundary } from "./permissions";
import { installMenu } from "./menu";

/**
 * userData는 productName이 아니라 package.json의 name에서 나오므로, dev와 packaged가
 * 같은 경로를 쓰게 이름을 고정한다 (스펙 §6.3). 고정하지 않으면 dev는
 * ~/Library/Application Support/damwha-desktop/를, packaged는 .../Damwha/를 써서
 * config.json·storage/·logs/가 갈라진다. getPath('userData')를 처음 읽기 전에 불러야
 * 하므로 모듈 최상단에 둔다 — requestSingleInstanceLock의 잠금도 이 경로를 쓴다.
 */
app.setName("Damwha");

/** 실패 후 자동 재시도 간격. 세 번째부터는 사람이 손 쓸 문제라 늘리지 않는다. */
const RETRY_DELAYS_MS = [3_000, 8_000, 20_000];
const STOP_GRACE_MS = 5_000;
/** 개발에서 렌더러는 Vite가 서빙한다. 그 포트는 Vite 기본값이다. */
const VITE_ORIGIN = "http://localhost:5173";

let win: BrowserWindow | null = null;
let api: ApiHandle | null = null;
/** ready 이전의 자식. api에 승격되기 전에 종료가 오면 이것을 정리해야 한다. */
let inFlight: ApiHandle | null = null;
let apiOrigin: string | null = null;
/** dev에서만 쓰인다. packaged는 API 자신의 origin을 로드하므로 Vite가 없다. */
let vite: ApiHandle | null = null;
/**
 * 마지막으로 Vite에 준 API base. VITE_API_BASE_URL은 Vite 기동 시점에 고정되므로,
 * 포트 폴백으로 API origin이 바뀌면 이 값과 비교해 Vite를 재기동할지 정한다.
 */
let viteApiBase: string | null = null;
let retryCount = 0;
let retryTimer: NodeJS.Timeout | null = null;
let quitting = false;
/**
 * start()가 겹치면 한 호출이 다른 호출의 자식을 죽이고도 이전 호출이 계속 전역 상태를
 * 갱신한다. 세대 번호로 최신 호출만 전역 상태와 창을 건드리게 한다.
 */
let generation = 0;
let starting: Promise<void> | null = null;

function allowedOrigins(): string[] {
  const list: string[] = [];
  if (apiOrigin !== null) list.push(apiOrigin);
  if (!app.isPackaged) list.push(VITE_ORIGIN);
  return list;
}

function logFile(): string {
  return path.join(app.getPath("userData"), "logs", "api.log");
}

function apiRoot(): string {
  // packaged: Contents/Resources/api. dev: 저장소 루트 (pnpm --filter가 be/로 내려간다).
  return app.isPackaged
    ? path.join(process.resourcesPath, "api")
    : path.resolve(app.getAppPath(), "..");
}

function createWindow(): BrowserWindow {
  const created = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "담화",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  applyNavigationBoundary(created, allowedOrigins);
  return created;
}

function cancelRetry(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

async function stopApi(): Promise<void> {
  const handles = [api, inFlight].filter((h): h is ApiHandle => h !== null);
  api = null;
  inFlight = null;
  apiOrigin = null;
  await Promise.all(handles.map((h) => h.stop(STOP_GRACE_MS)));
}

/** before-quit에서 쓴다. startOnce()의 재시도 경로는 Vite를 살려 둬야 하므로 stopApi()를 쓴다. */
async function stopAll(): Promise<void> {
  const v = vite;
  vite = null;
  viteApiBase = null;
  await Promise.all([stopApi(), v === null ? Promise.resolve() : v.stop(STOP_GRACE_MS)]);
}

/**
 * dev에서 렌더러가 볼 주소. Vite를 이 시점에 띄우고 첫 서빙까지 기다린다.
 * Vite는 API 포트가 바뀌어도 살려 둔다 — 재시도마다 재기동하면 HMR이 끊긴다. 단,
 * API origin이 포트 폴백으로 바뀌면 VITE_API_BASE_URL이 낡으므로 그때만 재기동한다.
 */
async function rendererTarget(apiBase: string): Promise<{ url: string } | { error: string }> {
  if (app.isPackaged) return { url: `${apiBase}/` };

  const wanted = `${apiBase}/api`;
  if (vite === null || !vite.alive() || viteApiBase !== wanted) {
    if (vite !== null) await vite.stop(STOP_GRACE_MS);
    vite = launchVite({ cwd: apiRoot(), apiBaseUrl: wanted });
    viteApiBase = wanted;
  }

  const up = await waitForReady({
    probe: async () => {
      try {
        const res = await fetch(VITE_ORIGIN, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        return res.status < 500 ? "ready" : "no-response";
      } catch {
        return "no-response";
      }
    },
    isAlive: () => vite?.alive() ?? false,
    timeoutMs: READY_TIMEOUT_MS,
    intervalMs: READY_INTERVAL_MS,
  });
  if (up.kind !== "ready") {
    return { error: `Vite를 띄우지 못했어요: ${lastMeaningfulLine(vite?.stderrTail() ?? "")}` };
  }
  return { url: VITE_ORIGIN };
}

function scheduleRetry(): number | undefined {
  const delay = RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)];
  retryCount += 1;
  cancelRetry();
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void start();
  }, delay);
  return Math.round(delay / 1000);
}

type AttemptOutcome =
  | { kind: "ready"; handle: ApiHandle; origin: string }
  | { kind: "db-unreachable"; handle: ApiHandle }
  | { kind: "addr-in-use" }
  | { kind: "failed"; handle: ApiHandle };

/** be/src/main.ts의 fail-fast가 찍는 문구. 이것이 DB 미기동의 유일한 신호다 — 이 경우
 *  API는 listen조차 하지 않으므로 health의 503은 관찰되지 않는다(스펙 §6.5). */
const DB_UNREACHABLE = /database unreachable/;

/**
 * 한 포트로 한 번 시도한다. 전역 `api`를 보지 않고 이 호출이 만든 handle만 관찰한다 —
 * 겹친 start()가 서로의 자식을 오관찰하지 않게 하려면 이 격리가 필요하다.
 */
async function attempt(port: number, env: ApiEnv): Promise<AttemptOutcome> {
  const launch = app.isPackaged ? launchPackaged : launchDev;
  const handle = launch({
    entry: path.join(apiRoot(), "dist", "main.js"),
    cwd: apiRoot(),
    env: { ...env, PORT: String(port) },
    logFile: logFile(),
  });
  inFlight = handle;
  const origin = `http://127.0.0.1:${port}`;
  const outcome = await waitForReady({
    probe: () => probeHealth(origin),
    isAlive: () => handle.alive(),
    timeoutMs: READY_TIMEOUT_MS,
    intervalMs: READY_INTERVAL_MS,
  });
  if (outcome.kind === "ready") return { kind: "ready", handle, origin };
  if (outcome.kind === "db-unreachable") return { kind: "db-unreachable", handle };

  // child-exited와 timeout 양쪽에서 stderr를 본다. 개발 모드의 자식은
  // nest start --watch 래퍼라 진짜 API가 죽어도 살아 있고, 그래서 outcome이
  // child-exited가 아니라 timeout으로 온다. child-exited에서만 보면 개발 모드에서
  // 포트 폴백이 영원히 일어나지 않고 DB 미기동 화면에도 닿지 못한다. tail은
  // handle마다 따로이므로 이 문구가 있으면 그 자식이 실제로 그 조건을 만난 것이다.
  const tail = handle.stderrTail();
  if (isAddrInUse(tail)) {
    await handle.stop(STOP_GRACE_MS);
    inFlight = null;
    return { kind: "addr-in-use" };
  }
  if (DB_UNREACHABLE.test(tail)) return { kind: "db-unreachable", handle };
  return { kind: "failed", handle };
}

/** ready 뒤에 자식이 죽으면 화면에 알린다. 자동 재시작은 Phase 2다 (스펙 §8). */
function watchForDeath(handle: ApiHandle, mine: number): void {
  handle.onExit((code) => {
    if (mine !== generation || quitting || win === null) return;
    api = null;
    apiOrigin = null;
    const seconds = scheduleRetry();
    void showStatus(win, {
      state: "failed",
      detail: `API가 종료됐어요 (코드 ${code}). ${lastMeaningfulLine(handle.stderrTail())}`,
      retryInSeconds: seconds,
      logPath: logFile(),
    });
  });
}

/** 동시 호출을 직렬화한다. 메뉴 재시도와 자동 재시도가 겹칠 수 있다. */
function start(): Promise<void> {
  const run = (starting ?? Promise.resolve()).then(() => startOnce());
  starting = run.catch(() => undefined);
  return run;
}

async function startOnce(): Promise<void> {
  if (win === null) return;
  generation += 1;
  const mine = generation;
  await stopApi();
  if (mine !== generation || win === null) return;
  await showStatus(win, { state: "starting" });

  const { env, warning } = loadConfig(app.getPath("userData"));
  const preferred = Number(env.PORT) || 3000;

  for (let i = 0; i < MAX_PORT_ATTEMPTS; i += 1) {
    const port = await choosePort(preferred, i);
    const outcome = await attempt(port, env);

    // 내가 도는 동안 더 새로운 start()가 시작됐다면 내가 만든 자식을 치우고 물러난다.
    if (mine !== generation) {
      if (outcome.kind !== "addr-in-use") {
        await outcome.handle.stop(STOP_GRACE_MS);
        inFlight = null;
      }
      return;
    }
    if (win === null) {
      if (outcome.kind !== "addr-in-use") {
        await outcome.handle.stop(STOP_GRACE_MS);
        inFlight = null;
      }
      return;
    }

    if (outcome.kind === "addr-in-use") continue;

    if (outcome.kind === "ready") {
      api = outcome.handle;
      inFlight = null;
      apiOrigin = outcome.origin;
      retryCount = 0;
      watchForDeath(outcome.handle, mine);
      try {
        const target = await rendererTarget(outcome.origin);
        if (mine !== generation || win === null) return;
        if ("error" in target) {
          const seconds = scheduleRetry();
          await showStatus(win, {
            state: "failed",
            detail: target.error,
            retryInSeconds: seconds,
            logPath: logFile(),
          });
          return;
        }
        await win.loadURL(target.url);
      } catch (e) {
        if (mine !== generation || win === null) return;
        const seconds = scheduleRetry();
        await showStatus(win, {
          state: "failed",
          detail: `화면을 불러오지 못했어요: ${e instanceof Error ? e.message : String(e)}`,
          retryInSeconds: seconds,
          logPath: logFile(),
        });
      }
      return;
    }

    const detail = [warning, lastMeaningfulLine(outcome.handle.stderrTail())]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join(" / ");
    await outcome.handle.stop(STOP_GRACE_MS);
    inFlight = null;
    const seconds = scheduleRetry();
    await showStatus(win, {
      state: outcome.kind === "db-unreachable" ? "db-unreachable" : "failed",
      detail: detail.length > 0 ? detail : undefined,
      retryInSeconds: seconds,
      logPath: logFile(),
    });
    return;
  }

  const seconds = scheduleRetry();
  await showStatus(win, {
    state: "failed",
    detail: `${MAX_PORT_ATTEMPTS}번 시도했지만 쓸 수 있는 포트를 찾지 못했어요.`,
    retryInSeconds: seconds,
    logPath: logFile(),
  });
}

// 중복 실행 방지 — 두 번째 인스턴스는 창을 만들지 않고 기존 창을 앞으로 보낸다 (스펙 P1-C6).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win === null) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    applyPermissionBoundary(allowedOrigins);
    installMenu(() => {
      retryCount = 0;
      cancelRetry();
      void start();
    });
    win = createWindow();
    win.on("closed", () => {
      win = null;
    });
    await start();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  // 앱이 만든 자식은 앱이 정리한다 (스펙 §6.2, P1-C5).
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    cancelRetry();
    event.preventDefault();
    void stopAll().then(() => app.quit());
  });
}
