import { app, BrowserWindow } from "electron";
import { execFile } from "child_process";
import * as net from "net";
import * as path from "path";
import { promisify } from "util";
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
import { lastMeaningfulLine } from "./stderr";
import { showStatus } from "./shell-window";
import { applyNavigationBoundary, applyPermissionBoundary } from "./permissions";
import { installMenu } from "./menu";

const execFileAsync = promisify(execFile);

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

/**
 * 이 세대가 아직 화면을 건드려도 되는가. 아니면 null이고, 부른 쪽은 물러난다.
 * 세 가지를 한자리에서 본다 — 예전에는 `mine !== generation || win === null`만 보는
 * 검사가 네 군데 흩어져 있었다.
 *
 * - 세대: 더 새로운 start()가 시작됐으면 이 호출의 관찰은 이미 낡았다.
 * - quitting: before-quit이 cancelRetry()를 이미 돌렸다. 여기서 화면을 갱신하거나
 *   재시도를 다시 걸면 종료가 치운 것을 되살린다 — 기동 중 종료가 정확히 이 모양이었다.
 * - isDestroyed: 'closed' 이벤트가 win을 null로 만들기 전에도 창은 파괴돼 있을 수 있고,
 *   그 창에 loadFile을 부르면 'Object has been destroyed'가 **동기로** 던져진다.
 *   win !== null만으로는 그 창을 걸러 내지 못한다.
 */
function activeWindow(mine: number): BrowserWindow | null {
  if (mine !== generation || quitting) return null;
  if (win === null || win.isDestroyed()) return null;
  return win;
}

/**
 * 물러나면서 내가 만든 자식을 남기지 않는다. 전역에 승격된 뒤에 물러나는 경우가 있어
 * (dev의 Vite 대기 중 종료) 전역 참조도 같이 끊는다 — stopAll()은 이미 지나갔을 수 있고,
 * 그 뒤에 남은 참조는 아무도 정리하지 않는다.
 */
async function abandon(handle: ApiHandle): Promise<void> {
  if (api === handle) {
    api = null;
    apiOrigin = null;
  }
  if (inFlight === handle) inFlight = null;
  await handle.stop(STOP_GRACE_MS);
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
  // 종료 중에는 걸지 않는다. before-quit이 cancelRetry()를 돌린 **뒤에** 기동 중이던
  // startOnce가 깨어나 여기 닿을 수 있고, 그러면 종료가 방금 치운 타이머가 되살아나
  // 아무도 치우지 않는다. 화면 문구의 "N초 뒤 재시도"도 거짓말이 된다.
  if (quitting) return undefined;
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
  | { kind: "unverified-owner"; handle: ApiHandle; port: number }
  | { kind: "failed"; handle: ApiHandle };

/** be/src/main.ts의 fail-fast가 찍는 문구. 이것이 DB 미기동의 유일한 신호다 — 이 경우
 *  API는 listen조차 하지 않으므로 health의 503은 관찰되지 않는다(스펙 §6.5). */
const DB_UNREACHABLE = /database unreachable/;

/**
 * 소유권 판정(스펙 §6.4, R1-11) 메커니즘 (a) — 스폰 전 사전 점검.
 * 후보 포트에 이미 응답하는 무언가가 있으면 자식을 아예 띄우지 않고 다음 포트로
 * 넘어간다. 값싸고, 흔한 경우(외부 API가 이미 그 포트를 쥐고 있음)를 스폰조차 없이
 * 막는다. `attempt()`가 매번 새 포트에 대해 부르므로 경쟁은 "점검 뒤 자식이 bind하는
 * 사이" 창 하나뿐이고, 그 창은 메커니즘 (b)가 닫는다.
 */
function isPortOccupied(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const settle = (occupied: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(occupied);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(PROBE_TIMEOUT_MS, () => settle(false));
  });
}

/** `lsof -sTCP:LISTEN`으로 그 포트에서 실제로 LISTEN 중인 pid들을 얻는다. 매치가
 *  없으면 lsof가 exit 1을 내는데, 이는 "리스너 없음"과 같은 뜻이라 빈 배열로 다룬다. */
async function listenerPids(port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/sbin/lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { timeout: 1_000 },
    );
    return stdout
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

/**
 * rootPid의 모든 자손 pid를 `ps`의 pid/ppid 목록에서 BFS로 모은다. 개발 모드의 자식은
 * pnpm → nest(CLI) → node(dist/main) 체인이라, 실제로 포트를 bind하는 것은 추적 중인
 * pid의 손자다 — 직계 비교만으로는 dev를 오판한다(실측: Fix round 1 보고서).
 */
async function descendantPids(rootPid: number): Promise<Set<number>> {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid,ppid"], { timeout: 1_000 });
  const rows = stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((row): row is [number, number] => row.length === 2 && row.every(Number.isInteger));

  const result = new Set<number>();
  let frontier = [rootPid];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const [pid, ppid] of rows) {
      if (frontier.includes(ppid) && !result.has(pid)) {
        result.add(pid);
        next.push(pid);
      }
    }
    frontier = next;
  }
  return result;
}

/**
 * 소유권 판정 메커니즘 (b) — 응답이 있어도 그 응답이 우리 자식에서 온 것인지 확인한다.
 * "그 포트에 응답이 있다"를 준비 신호로 쓰지 말라는 스펙 §6.4의 명시적 계약이다.
 * dev(자식 = pnpm, 실제 리스너는 손자)와 packaged(자식 = utilityProcess 헬퍼, 리스너
 * 자신) 양쪽 다 자손 집합에 자기 자신을 포함시켜 커버한다. lsof/ps 자체가 실패하면
 * 소유를 증명할 수 없으므로 안전하게 "아니오"로 본다 — 준비 판정은 실패 쪽으로 닫는다.
 */
async function verifyOwnListener(port: number, childPid: number | undefined): Promise<boolean> {
  if (childPid === undefined) return false;
  try {
    const [owners, descendants] = await Promise.all([listenerPids(port), descendantPids(childPid)]);
    return owners.some((pid) => pid === childPid || descendants.has(pid));
  } catch {
    return false;
  }
}

/**
 * 한 포트로 한 번 시도한다. 전역 `api`를 보지 않고 이 호출이 만든 handle만 관찰한다 —
 * 겹친 start()가 서로의 자식을 오관찰하지 않게 하려면 이 격리가 필요하다.
 */
async function attempt(port: number, env: ApiEnv): Promise<AttemptOutcome> {
  // 메커니즘 (a): 스폰 전에 포트가 이미 응답하는지 본다 — 외부 API가 점유한 흔한
  // 경우는 자식을 띄우지도 않고 여기서 걸러진다.
  if (await isPortOccupied(port)) return { kind: "addr-in-use" };

  const launch = app.isPackaged ? launchPackaged : launchDev;
  const handle = launch({
    entry: path.join(apiRoot(), "dist", "main.js"),
    cwd: apiRoot(),
    env: { ...env, PORT: String(port) },
    logFile: logFile(),
  });
  inFlight = handle;
  const origin = `http://127.0.0.1:${port}`;
  // health가 200을 준 적은 있지만 소유를 끝내 확인 못 한 채로 끝나는 경우를 구분해
  // 두려고 둔다 — Fix round 1의 결함(packaged의 pid가 fork() 직후 undefined라 소유
  // 확인이 매번 실패하던 버그)이 실패 화면에 아무 원인도 없이 30초 타임아웃으로만
  // 드러났었다. 자식은 죽지 않았는데 우리가 소유를 증명 못 했다는 사실 자체가
  // 화면에 보여야 다음에 같은 결함이 조용히 묻히지 않는다.
  let sawUnverifiedReady = false;
  const outcome = await waitForReady({
    probe: async () => {
      const result = await probeHealth(origin);
      if (result !== "ready") return result;
      // 메커니즘 (b): 200을 받았어도 그 소켓의 실제 리스너가 우리 자식(또는 그
      // 자손)인지 확인한다. 아니면 "아직 준비 안 됨"으로 돌려보내 폴링을 계속한다 —
      // 우리 자식이 뒤이어 EADDRINUSE로 죽으면 기존 분기가 다음 포트로 넘긴다.
      const owned = await verifyOwnListener(port, handle.pid);
      if (!owned) sawUnverifiedReady = true;
      return owned ? "ready" : "no-response";
    },
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
  // EADDRINUSE도 database unreachable도 아니면서 health 200을 본 적이 있는 timeout —
  // 자식이 진짜 응답하고 있는데 소유를 증명하지 못한 경우다(외부 프로세스가 계속
  // 버티고 있거나, lsof/ps 판정 도구 자체가 실패했거나). 이걸 그냥 "failed"로 뭉개면
  // 사람이 보는 화면은 stderr에 에러가 없어 detail이 빈 채로 30초 뒤 원인 불명 실패로만
  // 보인다 — Fix round 1의 결함이 정확히 이렇게 숨었었다.
  if (sawUnverifiedReady) return { kind: "unverified-owner", handle, port };
  return { kind: "failed", handle };
}

/** ready 뒤에 자식이 죽으면 화면에 알린다. 자동 재시작은 Phase 2다 (스펙 §8). */
function watchForDeath(handle: ApiHandle, mine: number): void {
  handle.onExit((code) => {
    // 이 콜백은 자식의 'exit' 이벤트 안에서 동기로 불린다. 여기서 던지면 Electron
    // main이 통째로 죽으므로, 창 판정은 win !== null이 아니라 isDestroyed()까지
    // 보는 activeWindow()로 한다 — 창을 닫는 것이 곧 자식을 죽이는 종료를 부르는
    // 구조라 "검사와 사용 사이에 창이 파괴되는" 경로가 실제로 열려 있다.
    const target = activeWindow(mine);
    if (target === null) return;
    api = null;
    apiOrigin = null;
    const seconds = scheduleRetry();
    // await할 수 없는 자리다(동기 이벤트 핸들러). 거부를 그대로 두면
    // unhandled rejection이 되므로 여기서 닫는다 — void는 삼켜 주지 않는다.
    void showStatus(target, {
      state: "failed",
      detail: `API가 종료됐어요 (코드 ${code}). ${lastMeaningfulLine(handle.stderrTail())}`,
      retryInSeconds: seconds,
      logPath: logFile(),
    }).catch(() => undefined);
  });
}

/** 동시 호출을 직렬화한다. 메뉴 재시도와 자동 재시도가 겹칠 수 있다. */
function start(): Promise<void> {
  const run = (starting ?? Promise.resolve()).then(() => startOnce());
  starting = run.catch(() => undefined);
  return run;
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * startOnce는 runStart를 감싸기만 한다. 이 wrapper가 있는 이유는 runStart가 **스스로**
 * 던지는 예외에 실패 경로가 없었다는 것이다 — 던질 수 있는 지점이 전부
 * `showStatus({state:"starting"})` 뒤라, 예외 하나가 앱을 "준비 중" 화면에 영원히
 * 세웠다. 상태 갱신도, 재시도도, 로그도 없다. 이 Phase가 이미 두 번 값을 치른 조용한
 * 정지와 같은 모양이고, 이번 문은 사용자가 직접 고치는 파일(`config.json`)에서 열린다.
 *
 * 개별 지점도 함께 막았다 — `config.json`의 PORT는 runStart가 미리 판정하고(choosePort에
 * 넘기지 않는다), `loadConfig`의 쓰기 실패는 `config.ts`가 경고로 바꿨다. 이 catch는
 * 남은 것(포트 탐색이 막힌 `freePort()`의 거부 등)과 앞으로 들어올 무엇이든 받는다.
 */
async function startOnce(): Promise<void> {
  if (win === null || win.isDestroyed()) return;
  generation += 1;
  const mine = generation;
  try {
    await runStart(mine);
  } catch (e) {
    const target = activeWindow(mine);
    if (target === null) return;
    const seconds = scheduleRetry();
    await showStatus(target, {
      state: "failed",
      detail: `앱을 시작하지 못했어요: ${reasonOf(e)}`,
      retryInSeconds: seconds,
      logPath: logFile(),
    }).catch(() => undefined);
  }
}

async function runStart(mine: number): Promise<void> {
  await stopApi();
  const opening = activeWindow(mine);
  if (opening === null) return;
  await showStatus(opening, { state: "starting" });

  const { env, warning } = loadConfig(app.getPath("userData"));
  const requested = Number(env.PORT);
  /**
   * `choosePort`는 1~65535의 정수가 아니면 **던진다.** `config.json`은 사용자가 직접
   * 고치는 파일이고 PORT는 API의 zod가 아니라 데스크톱 main이 먼저 먹는 값이라,
   * `{"PORT": 70000}` 한 줄이 기동을 예외로 끝냈다. 이제 두 가지를 한다.
   *
   * 1. 쓸 수 없는 값은 3000으로 되돌린다 — `choosePort`에 잘못된 값이 넘어가는 일이
   *    구조적으로 없어진다.
   * 2. 그래도 그 상태로 조용히 기동하지 않고 실패 화면에 원인을 적는다. 사용자가
   *    지정하지 않은 포트에 말없이 붙는 것은 보이지 않는 오동작이고, 3000이 점유돼
   *    있으면 포트 폴백까지 겹쳐 어디에 붙었는지조차 알 수 없게 된다. 설정 오류는
   *    P1-C8(카탈로그 밖 모델)과 같은 등급으로 다룬다 — 화면에 원인, 그리고 재시도.
   *    사용자가 파일을 고치면 다음 재시도의 `loadConfig`가 새 값을 읽는다.
   */
  const preferred =
    Number.isInteger(requested) && requested >= 1 && requested <= 65535 ? requested : 3000;
  if (preferred !== requested) {
    const seconds = scheduleRetry();
    await showStatus(opening, {
      state: "failed",
      detail: [
        warning,
        `config.json의 PORT 값 ${JSON.stringify(env.PORT)}은(는) 1~65535의 정수가 아니에요. 값을 고치면 다시 시도합니다.`,
      ]
        .filter((s): s is string => typeof s === "string" && s.length > 0)
        .join(" / "),
      retryInSeconds: seconds,
      logPath: logFile(),
    });
    return;
  }

  for (let i = 0; i < MAX_PORT_ATTEMPTS; i += 1) {
    // 자식을 띄우기 전에 한 번 더 본다. 기동 중에 종료가 들어오면 stopAll()이 이미
    // 끝난 뒤이므로, 여기서 새 자식을 띄우면 아무도 정리하지 않는 프로세스가 된다.
    if (activeWindow(mine) === null) return;
    const port = await choosePort(preferred, i);
    const outcome = await attempt(port, env);

    // 세대 교체·창 파괴·종료 — 어느 쪽이든 내가 만든 자식을 치우고 물러난다.
    const live = activeWindow(mine);
    if (live === null) {
      if (outcome.kind !== "addr-in-use") await abandon(outcome.handle);
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
        // dev에서는 위 await가 Vite를 기다리느라 길다. 그 사이에 종료가 들어오면
        // stopAll()은 방금 승격된 이 자식을 이미 지나쳤을 수 있다 — abandon이 끊는다.
        const shell = activeWindow(mine);
        if (shell === null) {
          await abandon(outcome.handle);
          return;
        }
        if ("error" in target) {
          const seconds = scheduleRetry();
          await showStatus(shell, {
            state: "failed",
            detail: target.error,
            retryInSeconds: seconds,
            logPath: logFile(),
          });
          return;
        }
        await shell.loadURL(target.url);
      } catch (e) {
        const shell = activeWindow(mine);
        if (shell === null) {
          await abandon(outcome.handle);
          return;
        }
        const seconds = scheduleRetry();
        await showStatus(shell, {
          state: "failed",
          detail: `화면을 불러오지 못했어요: ${reasonOf(e)}`,
          retryInSeconds: seconds,
          logPath: logFile(),
        });
      }
      return;
    }

    if (outcome.kind === "unverified-owner") {
      // 자식은 안 죽었다(EADDRINUSE도, database unreachable도 아니다) — 그런데도
      // 소유를 증명 못 했다는 사실 자체를 detail에 그대로 적는다. stderr에는 보통
      // 아무 에러도 없어서(자식이 실제로는 건강하게 응답 중이므로) 기존 lastMeaningfulLine
      // 경로를 타면 detail이 비어 "원인 불명 실패"로만 보인다.
      await outcome.handle.stop(STOP_GRACE_MS);
      inFlight = null;
      const seconds = scheduleRetry();
      await showStatus(live, {
        state: "failed",
        detail: `포트 ${outcome.port}에서 응답을 받았지만 우리가 띄운 자식 소유인지 확인하지 못했어요. 다른 프로세스가 그 포트를 이미 쓰고 있을 수 있어요.`,
        retryInSeconds: seconds,
        logPath: logFile(),
      });
      return;
    }

    // stop() 전에 읽는다 — 아직 살아 있는 자식(dev의 pnpm 래퍼)이면 stop()의 강제
    // 종료가 만든 코드가 아니라 "아직 종료 안 됨"을 그대로 보여야 한다.
    const exitCode = outcome.handle.exitCode();
    const detail = [
      warning,
      lastMeaningfulLine(outcome.handle.stderrTail()),
      exitCode !== null ? `(종료 코드 ${exitCode})` : undefined,
    ]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join(" / ");
    await outcome.handle.stop(STOP_GRACE_MS);
    inFlight = null;
    const seconds = scheduleRetry();
    await showStatus(live, {
      state: outcome.kind === "db-unreachable" ? "db-unreachable" : "failed",
      detail: detail.length > 0 ? detail : undefined,
      retryInSeconds: seconds,
      logPath: logFile(),
    });
    return;
  }

  const exhausted = activeWindow(mine);
  if (exhausted === null) return;
  const seconds = scheduleRetry();
  await showStatus(exhausted, {
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
    // preventDefault로 이번 종료를 막았으므로 app.quit()이 반드시 다시 불려야 한다.
    // .then()이면 stopAll()이 거부할 때 그 호출이 통째로 사라져 앱이 창도 없이
    // 남는다 — 첫 Cmd+Q 뒤로 영영 끝나지 않는다. 자식을 못 죽였더라도 종료는 진행한다.
    void stopAll()
      .catch(() => undefined)
      .finally(() => app.quit());
  });
}
