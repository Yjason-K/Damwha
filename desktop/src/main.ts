import { app, BrowserWindow, dialog } from "electron";
import { execFile } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { promisify } from "util";
import { loadConfig, type ApiEnv } from "./config";
import { createConfigReloader } from "./config-reload";
import {
  PROBE_TIMEOUT_MS,
  READY_INTERVAL_MS,
  READY_TIMEOUT_MS,
  waitForReady,
} from "./readiness";
import type { ApiHandle } from "./api-process";
import { launchVite } from "./vite-process";
import { lastMeaningfulLine } from "./stderr";
import { showStatus, type ShellStatus } from "./shell-window";
import { applyNavigationBoundary, applyPermissionBoundary } from "./permissions";
import { mayRenderShell } from "./shell-latch";
import { maySpawnServices } from "./spawn-guard";
import { openWindowFlow } from "./window-flow";
import { installMenu } from "./menu";
import { createSupervisor } from "./services/supervisor";
import { buildSpecs } from "./services/specs";
import {
  listExternalWorkers as scanExternalWorkers,
  probeEmbedContract,
} from "./services/external";
import { findExecutable, searchDirs } from "./services/resolve";
import { isRepoRoot } from "./repo-root";
import { rotateIfNeeded } from "./logs";
import { freePort } from "./port";
import type {
  LaunchContext,
  ProcessState,
  ServiceId,
  ServiceStatus,
} from "./services/types";

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

const SERVICE_LABELS: Record<ServiceId, string> = {
  postgres: "데이터베이스",
  api: "API",
  embed: "검색 임베딩",
  worker: "작업 처리기",
};
const PROCESS_LABELS: Record<ProcessState, string> = {
  stopped: "대기 중",
  starting: "준비 중",
  running: "실행 중",
  failed: "실패",
};

let win: BrowserWindow | null = null;
/** dev에서만 쓰인다. packaged는 API 자신의 origin을 로드하므로 Vite가 없다. */
let vite: ApiHandle | null = null;
/**
 * 마지막으로 Vite에 준 API base. VITE_API_BASE_URL은 Vite 기동 시점에 고정되므로,
 * 포트 폴백으로 API origin이 바뀌면 이 값과 비교해 Vite를 재기동할지 정한다.
 */
let viteApiBase: string | null = null;
/** 이번 실행이 쓰는 저장소 체크아웃. resolveRepoRoot가 정하고 Vite 기동도 이것을 쓴다. */
let repoRoot: string | null = null;
/**
 * 담화 화면을 붙여 둔 창. boolean이 아니라 **창 자체**를 드는 이유는 shell-latch.ts에 있다 —
 * 창이 닫히거나 갈리면 이 값은 자동으로 낡고, mayRenderShell이 그것을 본다. boolean 래치는
 * 자기가 기술하는 창보다 오래 살아서, 창을 한 번 닫으면 그 뒤 어떤 상태도 화면에 닿지
 * 못했다 (Task 12 리뷰 Critical-1).
 */
let attachedWindow: BrowserWindow | null = null;
let lastStatusLine = "";
let retryCount = 0;
let retryTimer: NodeJS.Timeout | null = null;
let quitting = false;
/**
 * start()가 겹치면 한 호출이 다른 호출의 자식을 죽이고도 이전 호출이 계속 전역 상태를
 * 갱신한다. 세대 번호로 최신 호출만 전역 상태와 창을 건드리게 한다.
 */
let generation = 0;
let starting: Promise<void> | null = null;
/** 넷을 쥔 감독자. 실행당 하나다 — 아래 startServices의 주석에 이유가 있다. */
let supervisor: ReturnType<typeof createSupervisor> | null = null;
/**
 * 감독자가 쥔 LaunchContext와, 그 env를 만든 config.json의 값(baseline). 재시도가 파일을 다시
 * 읽어 ctx.env에 얹을 때 "파일에서 온 값"과 "prepare()가 옮긴 값"을 가르는 기준이 baseline이다
 * (config.ts의 refreshEnv).
 */
let launchCtx: { ctx: LaunchContext; baseline: ApiEnv } | null = null;
/**
 * "이 값은 앱을 다시 켜야 바뀌어요" 안내. 재적용기가 매번 다시 계산하므로 어긋남이 풀리면
 * 저절로 null이 된다. 화면이 이것을 말하지 않으면 사용자는 자기 수정이 왜 안 먹는지 알 길이
 * 없고, 그 침묵이 재리뷰 §4-1의 절반이었다.
 */
let restartNotice: string | null = null;

/** 앱이 정한 API origin. 감독자의 런타임에서 읽는다 — 전역 변수를 따로 두면 갈린다. */
function currentApiOrigin(): string | null {
  return supervisor?.runtimeOf("api")?.result?.origin ?? null;
}

function allowedOrigins(): string[] {
  const list: string[] = [];
  const origin = currentApiOrigin();
  if (origin !== null) list.push(origin);
  if (!app.isPackaged) list.push(VITE_ORIGIN);
  return list;
}

function logPathOf(id: ServiceId | "supervisor"): string {
  return path.join(app.getPath("userData"), "logs", `${id}.log`);
}

/** 감독자 자신의 판단 기록. 자식의 stdout이 아니라 앱이 무엇을 왜 했는지가 여기 남는다. */
function appendSupervisorLog(line: string): void {
  try {
    const file = logPathOf("supervisor");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // 로그를 못 쓰는 것은 앱이 죽을 이유가 아니다 (Phase 1의 makeSink와 같은 규칙).
  }
}

/**
 * config.json에 한 키만 덧쓴다. 파일 전체를 다시 쓰지 않는 이유는 사용자가 손으로 넣은
 * 다른 키와 주석 없는 포맷을 보존하기 위해서다. 실패해도 기동을 막지 않는다 — 다음 실행에
 * 다시 물어보면 된다.
 */
function saveConfigValue(userData: string, key: string, value: string): void {
  const file = path.join(userData, "config.json");
  try {
    const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "{}";
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed[key] = value;
    fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  } catch (e) {
    appendSupervisorLog(`config.json에 ${key}를 저장하지 못했어요: ${String(e)}`);
  }
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

/**
 * 창을 만들고 전역과 'closed'를 잇는다. whenReady와 activate가 같은 세 줄을 각각 갖고 있었고,
 * 한쪽만 고치는 사고가 정확히 리뷰 Important-3이었다. 창 생성은 이 한 자리뿐이다.
 */
function openWindow(): BrowserWindow {
  const created = createWindow();
  win = created;
  created.on("closed", () => {
    // 더 새 창이 이미 전역을 차지했으면 그것을 지우지 않는다.
    if (win === created) win = null;
  });
  return created;
}

/**
 * 준비 화면을 띄운다. showStatus를 직접 부르지 않는 이유는 이 한 줄 때문이다 — 창이 다시
 * 셸 화면을 보고 있다는 사실을 renderStatus가 알아야, 그 뒤의 상태 변화가 화면에 닿는다.
 */
function showShell(target: BrowserWindow, status: ShellStatus): Promise<void> {
  attachedWindow = null;
  return showStatus(target, status);
}

function cancelRetry(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

/**
 * 이 세대가 아직 화면을 건드리고 자식을 띄워도 되는가. 아니면 null이고, 부른 쪽은 물러난다.
 * 예전에는 `mine !== generation || win === null`만 보는 검사가 네 군데 흩어져 있었다.
 *
 * 판정은 spawn-guard.ts에 있다 — electron 전역을 **읽는 일**만 여기 남는다. 같은 규칙을 두 벌
 * 적으면(여기 하나, 스폰 직전에 하나) 한쪽만 고치는 사고가 나므로 그 술어는 하나다. 세 조건의
 * 근거는 그 모듈의 주석에 있다.
 */
function activeWindow(mine: number): BrowserWindow | null {
  const current = win;
  const may = maySpawnServices({
    quitting,
    generation,
    mine,
    hasWindow: current !== null && !current.isDestroyed(),
  });
  return may ? current : null;
}

/**
 * before-quit에서 쓴다. 감독자가 자식을 소유하므로 여기서는 감독자에게 넘기고, dev의
 * Vite만 직접 내린다 (Vite는 감독자가 모르는 자식이다).
 *
 * Task 13이 이 자리를 종료 계약(핸드셰이크·대화상자·자손 스냅샷)으로 바꾼다. 지금은
 * Phase 1과 같은 모양 — "앱이 만든 자식은 앱이 정리한다"(스펙 §6.2, P1-C5) — 을 감독자를
 * 향해 그대로 유지한다. 여기를 비워 두면 넷 중 셋이 detached 자식이라 앱이 죽어도 살아남는다.
 */
async function stopAll(): Promise<void> {
  const v = vite;
  vite = null;
  viteApiBase = null;
  const sup = supervisor;
  await Promise.all([
    v === null ? Promise.resolve() : v.stop(STOP_GRACE_MS),
    sup === null
      ? Promise.resolve()
      : sup.stopAll({ graceMs: STOP_GRACE_MS }).then((out) => {
          if (!out.stopped) {
            appendSupervisorLog(
              `종료: 정리하지 못한 프로세스가 남았어요 (pid ${out.leaked.join(", ") || "확인 불가"}).`,
            );
          }
        }),
  ]);
}

/**
 * dev에서 렌더러가 볼 주소. Vite를 이 시점에 띄우고 첫 서빙까지 기다린다.
 * Vite는 API 포트가 바뀌어도 살려 둔다 — 재시도마다 재기동하면 HMR이 끊긴다. 단,
 * API origin이 포트 폴백으로 바뀌면 VITE_API_BASE_URL이 낡으므로 그때만 재기동한다.
 */
async function rendererTarget(apiBase: string): Promise<{ url: string } | { error: string }> {
  if (app.isPackaged) return { url: `${apiBase}/` };
  if (repoRoot === null) return { error: "저장소 폴더를 확인하지 못해 개발 서버를 띄울 수 없어요." };

  const wanted = `${apiBase}/api`;
  if (vite === null || !vite.alive() || viteApiBase !== wanted) {
    if (vite !== null) await vite.stop(STOP_GRACE_MS);
    vite = launchVite({ cwd: repoRoot, apiBaseUrl: wanted });
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

/**
 * 소유권 판정(스펙 §6.4, R1-11) 메커니즘 (a) — 스폰 전 사전 점검.
 * 후보 포트에 이미 응답하는 무언가가 있으면 자식을 아예 띄우지 않고 다음 포트로
 * 넘어간다. 값싸고, 흔한 경우(외부 API가 이미 그 포트를 쥐고 있음)를 스폰조차 없이
 * 막는다. apiSpec.launch()가 매번 새 포트에 대해 부르므로 경쟁은 "점검 뒤 자식이 bind하는
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
 *
 * **root 자신은 결과에 들어 있지 않다.** 부르는 쪽이 합쳐야 한다 — verifyOwnListener는
 * `pid === childPid || …`로, listExternalWorkers는 `ours.add(pid)`로 그렇게 한다.
 * export하는 이유는 Task 13의 stopWorkerProcess가 같은 조회를 쓰기 때문이다.
 */
export async function descendantPids(rootPid: number): Promise<Set<number>> {
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
 * 감독자에 넘기는 배선. 판정 자체(우리 것을 빼는 두 줄 포함)는 services/external.ts에
 * 있다 — 여기 두면 electron을 값으로 import하는 이 파일이라 어떤 테스트도 그것을 부를 수
 * 없고, `ours.add(pid)`를 빠뜨려도 초록불이 유지된다.
 */
function listExternalWorkers(): Promise<number[]> {
  return scanExternalWorkers({
    ps: async () =>
      (await execFileAsync("/bin/ps", ["-axo", "pid,command"], { timeout: 2_000 })).stdout,
    ownPid: () => supervisor?.runtimeOf("worker")?.result?.handle?.pid,
    descendants: descendantPids,
  });
}

async function dockerRun(bin: string, args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: 30_000 });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? String(e), code: err.code ?? 1 };
  }
}

/**
 * REPO_ROOT를 빌드 시점에 굽지 않는다 — 번들 안에 저장소 절대 경로가 들어가면 Phase 1의
 * 위생 기준(P1-C11)이 깨진다. 못 찾으면 사람에게 한 번 묻고 config.json에 적는다.
 * Phase 3·4가 번들을 넣으면 이 물음 자체가 사라진다 (스펙 §6.4).
 */
async function resolveRepoRoot(configured: string | undefined): Promise<string | null> {
  if (configured !== undefined && isRepoRoot(configured)) return configured;
  if (!app.isPackaged) {
    const guess = path.resolve(app.getAppPath(), "..");
    if (isRepoRoot(guess)) return guess;
  }
  const picked = await dialog.showOpenDialog({
    title: "담화 저장소 폴더를 골라 주세요",
    message: "be/worker와 be/docker-compose.yml이 있는 폴더입니다.",
    properties: ["openDirectory"],
  });
  const dir = picked.filePaths[0];
  // 고른 폴더도 검증한다. 아무 폴더나 받으면 이후 모든 실패가 엉뚱한 원인을 말한다.
  if (dir === undefined || !isRepoRoot(dir)) return null;
  saveConfigValue(app.getPath("userData"), "REPO_ROOT", dir);
  return dir;
}

function statusLine(s: ServiceStatus): string {
  const adopted = s.process === "running" && !s.owned ? " (앱이 띄우지 않음)" : "";
  const degraded = s.health === "degraded" ? " — 동작이 제한돼요" : "";
  const why = s.detail !== undefined && (s.process === "failed" || s.health === "degraded")
    ? `\n    ${s.detail.split("\n").join("\n    ")}`
    : "";
  return `${SERVICE_LABELS[s.id]}: ${PROCESS_LABELS[s.process]}${adopted}${degraded}${why}`;
}

/** 감독자의 지금 상태를 셸 화면 한 장으로 접는다. 실패가 있으면 그 원인을 머리에 세운다. */
function shellStatusOf(): ShellStatus {
  const all = supervisor?.statuses() ?? [];
  // 화면이 "값을 고치면 다시 시도합니다"라고 적는 이상, 고쳐도 반영되지 않는 값은 화면이
  // 말해야 한다. 조용히 어긋난 채로 두는 것이 재리뷰 §4-1이 지적한 결함의 절반이다.
  const lines = [...all.map(statusLine), ...(restartNotice === null ? [] : [restartNotice])];
  const failed = all.find((s) => s.process === "failed");
  if (failed === undefined) return { state: "starting", detail: lines.join("\n") };
  return {
    // postgres가 넘어졌으면 그 화면의 문구("데이터베이스에 연결할 수 없어요")가 맞다.
    state: failed.id === "postgres" ? "db-unreachable" : "failed",
    detail: lines.join("\n"),
    // postgres는 컨테이너라 자기 로그 파일이 없다 — 앱의 판단 기록으로 보낸다.
    logPath: logPathOf(failed.id === "postgres" ? "supervisor" : failed.id),
  };
}

/**
 * 감독자의 상태 변화를 두 곳으로 보낸다 — supervisor.log와, 아직 준비 화면이 떠 있는
 * 동안의 창.
 *
 * 렌더러가 이미 붙은 뒤에는 창을 건드리지 않는다. showStatus는 loadFile이라 앱을 쓰는
 * 중에 부르면 사용자가 보던 것을 준비 화면으로 갈아 끼운다. ready 이후의 사망은 감독자가
 * 백오프로 되살리는 중이므로(스펙 §6.8) 그 복구를 화면 전환으로 덮지 않는다.
 */
function renderStatus(statuses: ServiceStatus[]): void {
  const line = statuses
    .map((s) => `${s.id}=${s.process}/${s.health}${s.owned ? "" : "(외부)"}`)
    .join(" ");
  if (line !== lastStatusLine) {
    lastStatusLine = line;
    appendSupervisorLog(`상태 ${line}`);
  }
  const target = activeWindow(generation);
  if (target === null) return;
  if (!mayRenderShell(attachedWindow, target)) return;
  void showShell(target, shellStatusOf()).catch(() => undefined);
}

/**
 * 창을 다시 연 뒤 화면을 붙인다. 서비스는 이미 떠 있으므로 다시 띄우지 않는다 —
 * activate에서 startServices()를 부르면 넷을 또 띄운다.
 */
async function reattachWindow(mine: number): Promise<void> {
  const origin = currentApiOrigin();
  const target = activeWindow(mine);
  if (target === null) return;
  if (origin === null) {
    // 아직 준비 전이면 준비 화면, 이미 넘어져 멈춰 있으면 그 원인을 보여준다 — "준비 중"을
    // 계속 걸어 두면 아무도 준비하고 있지 않은데 기다리라고 말하는 셈이다.
    await showShell(target, shellStatusOf());
    return;
  }
  const renderer = await rendererTarget(origin);
  if ("error" in renderer) {
    await showShell(target, {
      state: "failed",
      detail: renderer.error,
      logPath: logPathOf("api"),
    });
    return;
  }
  // loadURL이 끝난 뒤에 올리면 그 사이에 들어온 상태 갱신이 방금 붙인 앱 화면을 준비
  // 화면으로 되돌린다. 붙이기 **전에** 올린다.
  attachedWindow = target;
  await target.loadURL(renderer.url);
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
 * 실패를 화면과 재시도로 바꾼다. startOnce와 activate가 **같은** 안전망을 쓴다 — Task 12는
 * 이것을 startOnce에만 뒀고, activate의 loadURL 거부는 supervisor.log 한 줄로 끝나 창이
 * 영구히 빈 흰 화면으로 남았다 (리뷰 Important-3).
 */
async function reportFailure(mine: number, what: string, e: unknown): Promise<void> {
  appendSupervisorLog(`${what} — ${reasonOf(e)}`);
  const target = activeWindow(mine);
  if (target === null) return;
  const seconds = scheduleRetry();
  await showShell(target, {
    state: "failed",
    detail: `${what}: ${reasonOf(e)}`,
    retryInSeconds: seconds,
    logPath: logPathOf("supervisor"),
  }).catch(() => undefined);
}

/**
 * startOnce는 startServices를 감싸기만 한다. 이 wrapper가 있는 이유는 그 안쪽이 **스스로**
 * 던지는 예외에 실패 경로가 없었다는 것이다 — 던질 수 있는 지점이 전부
 * `showStatus({state:"starting"})` 뒤라, 예외 하나가 앱을 "준비 중" 화면에 영원히
 * 세웠다. 상태 갱신도, 재시도도, 로그도 없다. 이 Phase가 이미 두 번 값을 치른 조용한
 * 정지와 같은 모양이고, 이번 문은 사용자가 직접 고치는 파일(`config.json`)에서 열린다.
 */
async function startOnce(): Promise<void> {
  if (win === null || win.isDestroyed()) return;
  generation += 1;
  const mine = generation;
  try {
    await startServices(mine);
  } catch (e) {
    await reportFailure(mine, "앱을 시작하지 못했어요", e);
  }
}

async function startServices(mine: number): Promise<void> {
  const opening = activeWindow(mine);
  if (opening === null) return;
  await showShell(opening, { state: "starting" });

  const existing = supervisor;
  if (existing === null) {
    if (!(await createSupervisorFor(mine))) return;
  } else {
    // 재시도 전에 config.json을 다시 읽는다. 실패 화면이 "값을 고치면 다시 시도합니다"라고
    // 적는데 ctx.env가 감독자 생성 시점에 얼어붙으면 그 문장이 거짓이 된다 (완료 기준 P2-C8).
    // 실행 중에 바꿀 수 없는 키는 바꾸지 않고 안내를 돌려준다 — shellStatusOf가 그것을 화면에
    // 얹는다.
    restartNotice = reloadConfig();
    // 이미 감독자가 있으면 **다시 만들지 않는다.** 두 번째 감독자를 세우면 첫 감독자가 쥔
    // 자식들의 유일한 참조가 사라져 아무도 그들을 내리지 못하고, 넷이 두 벌 뜬다 (P2-C4).
    // 재시도는 감독자 자신의 입구를 쓴다 — prepare()를 건너뛰고 아직 못 뜬 것부터 잇는다
    // (supervisor.ts의 retry 주석).
    await existing.retry();
  }

  const all = supervisor?.statuses() ?? [];
  const api = all.find((s) => s.id === "api");
  if (api?.process !== "running") {
    const target = activeWindow(mine);
    if (target === null) return;
    await showShell(target, { ...shellStatusOf(), retryInSeconds: scheduleRetry() });
    return;
  }
  retryCount = 0;
  // origin은 감독자의 런타임에서 읽는다. Phase 1의 전역 apiOrigin은 이제 쓰지 않는다.
  await reattachWindow(mine);
}

/**
 * 재시도가 읽는 config.json. Phase 1은 재시도마다 loadConfig를 다시 읽었고, 감독자를 실행당
 * 하나로 묶으면서 그것이 사라졌다 (리뷰 Minor-3). 판정(무엇을 반영하고, 무엇을 두고, 무엇을
 * 한 번만 적는가)은 config-reload.ts에 있다 — 여기 두면 어떤 테스트도 그것을 부를 수 없고,
 * 실제로 그 자리에 있는 동안 결함 둘이 그 안에서 났다 (재리뷰 §4-1·§4-2).
 *
 * 자식 env만 다시 읽는다. ctx.bins(uv·docker)와 repoRoot는 여기서 갱신해도 소용이 없다 —
 * postgresSpec은 docker 경로를 클로저로 이미 붙잡고 있어 ctx를 고쳐도 옛 값을 쓴다. 그 둘을
 * 반영하려면 감독자를 다시 만들어야 하고, 그것은 첫 감독자가 쥔 자식 셋의 유일한 참조를
 * 버리는 일이라 P2-C4가 금지한다. 그러므로 실패 화면의 "값을 고치면 다시 시도합니다"가 참인
 * 범위는 DATABASE_URL·STORAGE_ROOT·PORT 같은 **자식 env 키**다.
 */
const reloadConfig = createConfigReloader({
  load: () => loadConfig(app.getPath("userData")),
  live: () => (launchCtx === null ? null : { env: launchCtx.ctx.env, baseline: launchCtx.baseline }),
  log: appendSupervisorLog,
});

/**
 * 감독자를 세운다. 세울 수 없는 이유(설정 오류)를 화면에 적었으면 false를 돌려주고,
 * 부른 쪽은 물러난다. 던지는 실패(저장소·docker 부재)는 startOnce의 catch가 받는다.
 */
async function createSupervisorFor(mine: number): Promise<boolean> {
  const userData = app.getPath("userData");
  const cfg = loadConfig(userData);
  if (cfg.warning !== undefined) appendSupervisorLog(cfg.warning);

  const requested = Number(cfg.env.PORT);
  /**
   * `choosePort`는 1~65535의 정수가 아니면 **던진다.** `config.json`은 사용자가 직접
   * 고치는 파일이고 PORT는 API의 zod가 아니라 데스크톱 main이 먼저 먹는 값이라,
   * `{"PORT": 70000}` 한 줄이 기동을 예외로 끝냈다. 어댑터가 못 쓸 값을 3000으로 되돌리긴
   * 하지만, 그 상태로 조용히 기동하지 않고 화면에 원인을 적는다 — 사용자가 지정하지 않은
   * 포트에 말없이 붙는 것은 보이지 않는 오동작이다. 파일을 고치면 다음 재시도가 읽는다.
   */
  if (!(Number.isInteger(requested) && requested >= 1 && requested <= 65535)) {
    const target = activeWindow(mine);
    if (target === null) return false;
    const seconds = scheduleRetry();
    await showShell(target, {
      state: "failed",
      detail: [
        cfg.warning,
        `config.json의 PORT 값 ${JSON.stringify(cfg.env.PORT)}은(는) 1~65535의 정수가 아니에요. 값을 고치면 다시 시도합니다.`,
      ]
        .filter((s): s is string => typeof s === "string" && s.length > 0)
        .join(" / "),
      retryInSeconds: seconds,
      logPath: logPathOf("supervisor"),
    });
    return false;
  }

  const resolved = await resolveRepoRoot(cfg.repoRoot);
  if (resolved === null) throw new Error("저장소 폴더를 확인하지 못했어요.");
  repoRoot = resolved;

  const dirs = searchDirs(app.getPath("home"), cfg.extraPath);
  const uv = cfg.uvBin ?? findExecutable("uv", dirs);
  const docker = cfg.dockerBin ?? findExecutable("docker", dirs);
  if (docker === null) {
    throw new Error(
      "docker를 찾지 못했어요. Docker Desktop을 설치했는지, config.json의 DOCKER_BIN 경로가 맞는지 확인해 주세요.",
    );
  }

  const ctx: LaunchContext = {
    repoRoot: resolved,
    userData,
    packaged: app.isPackaged,
    env: cfg.env,
    bins: { uv, docker },
    searchDirs: dirs,
    logFile: logPathOf,
  };
  // 스트림이 열린 뒤 옮기면 열린 핸들이 옮겨진 파일을 계속 가리킨다 — 띄우기 전에 돌린다.
  for (const id of ["supervisor", "api", "worker", "embed"] as const) {
    rotateIfNeeded(logPathOf(id));
  }

  const wantEmbed = {
    model: cfg.env.SEARCH_EMBEDDING_MODEL ?? "BAAI/bge-m3",
    dimension: Number(cfg.env.SEARCH_EMBEDDING_DIM ?? "1024"),
  };

  // 자식을 띄우기 전에 한 번 더 본다. 여기까지 오는 길에는 resolveRepoRoot의 폴더 선택
  // 대화상자가 있고(packaged 첫 실행에서는 상한이 없다), 그 사이에 ⌘Q가 들어오면 stopAll()은
  // supervisor를 null로 스냅숏해 아무것도 정리하지 않고 끝난다. 그 **뒤에** 이 컨티뉴에이션이
  // docker compose up -d와 detached 자식 둘을 띄우면 아무도 정리하지 않는 프로세스가 된다.
  // 감독자가 선 뒤로는 감독자 자신의 stopping/pending이 같은 일을 하므로, 구멍은 정확히
  // supervisor가 아직 null인 이 구간 하나다 — Phase 1의 runStart에 있던 검사와 같다
  // (리뷰 Important-2).
  if (activeWindow(mine) === null) return false;

  // 선언 배열은 services/specs.ts에 있다. 종료 순서(§6.9)와 게이트 집합(§6.7)을 그 배열
  // 하나가 정하는데, 여기 두면 어떤 테스트도 그것을 부를 수 없다 (specs.ts의 주석).
  const created = createSupervisor(
    buildSpecs({
      docker: (args) => dockerRun(docker, args),
      api: {
        verifyOwnListener,
        isPortOccupied,
        onPendingMigrations: () => undefined,
        onMigrationCheckSkipped: () =>
          appendSupervisorLog("마이그레이션 검사가 건너뛰어졌어요 — 통과한 것이 아닙니다."),
      },
      embed: { probe: (url) => probeEmbedContract(url, wantEmbed), freePort },
      worker: { listExternal: listExternalWorkers },
    }),
    ctx,
    { onStatus: renderStatus, log: appendSupervisorLog },
  );
  // start()가 끝나기 전에 대입해야 한다 — onStatus가 그 사이에 여러 번 발화하고, shellStatusOf()는
  // supervisor에서 상태를 읽는다. 대입이 뒤면 기동 화면에 서비스 줄이 한 줄도 안 뜬다.
  supervisor = created;
  launchCtx = { ctx, baseline: { ...cfg.env } };

  try {
    await created.start();
  } catch (e) {
    // 거부된 기동이 감독자를 남기면 이후 모든 재시도가 retry() 분기로 가 prepare()를 **영영**
    // 건너뛴다. 그러면 EMBED_SERVICE_URL이 채워지지 않고 embedSpec의 클로저 url이 ""로 남아
    // readiness가 180초 뒤 failed로 떨어진다. Task 5가 rt.result로 같은 모양의 사고를 냈다
    // (리뷰 Minor-2). 버려도 고아가 되는 자식은 없다 — start()가 거부할 수 있는 지점은
    // prepare() 하나이고(bringOnce는 자기 예외를 전부 상태로 바꾼다) 그것은 어떤 launch보다
    // 먼저 돈다.
    if (supervisor === created) supervisor = null;
    if (launchCtx?.ctx === ctx) launchCtx = null;
    throw e;
  }
  return true;
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
    openWindow();
    await start();
  });

  // macOS 관례. 창을 닫아도 앱과 서비스는 계속 돈다 — 긴 전사가 창을 닫아도 이어진다.
  // Dock에 남으므로 "껐다고 생각했는데 돌고 있다"는 상태는 아니다 (스펙 §6.10).
  app.on("window-all-closed", () => {
    // 의도적으로 app.quit()을 부르지 않는다. Phase 1은 여기서 종료했다.
  });

  app.on("activate", () => {
    if (win !== null && !win.isDestroyed()) {
      win.show();
      win.focus();
      return;
    }
    const opened = openWindow();
    const mine = generation;
    // 서비스는 이미 떠 있다. 화면만 다시 붙인다 — 다만 **셸 화면을 먼저 건다.** 그러지 않으면
    // reattachWindow가 loadURL에 닿을 때까지 창이 빈 흰 화면이고(dev에서 Vite가 죽어 있으면
    // rendererTarget이 재기동 + waitForReady의 30초를 통째로 그렇게 돈다), 지금 서비스가 어떤
    // 상태인지도 보이지 않는다. showShell이 래치도 같이 내려 renderStatus가 이 창을 다시
    // 그릴 수 있게 된다 (완료 기준 P2-C12, 리뷰 Important-3).
    // 순서와 실패 경로는 window-flow.ts가 정한다. 잎(loadFile·loadURL·대화상자)만 여기 있다.
    void openWindowFlow({
      showShell: () => showShell(opened, shellStatusOf()),
      attach: () => reattachWindow(mine),
      onFailure: (e) => reportFailure(mine, "창을 다시 붙이지 못했어요", e),
    }).catch((e: unknown) => {
      // 실패 처리 자체가 거부하면 여기서 멈춘다 — void 프라미스의 거부는 Electron main의
      // uncaught exception이 되고, 하필 화면이 이미 잘못된 순간에 난다.
      appendSupervisorLog(`창을 다시 붙이는 중 예외 — ${reasonOf(e)}`);
    });
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
