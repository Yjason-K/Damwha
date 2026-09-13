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
import { createServicesWindow, showStatus, type ShellStatus } from "./shell-window";
import { CAUSES } from "./causes";
import { failureDetail, servicesView, shellStatusFrom } from "./status-view";
import { createStatusWindow, mayAutoOpen } from "./status-window";
import { applyNavigationBoundary, applyPermissionBoundary } from "./permissions";
import { mayRenderShell } from "./shell-latch";
import { maySpawnServices } from "./spawn-guard";
import { decideMenuRetry, openWindowFlow } from "./window-flow";
import {
  createFlowLatch,
  graceExpiryPrompt,
  runCloseFlow,
  runQuitFlow,
  type QuitNotice,
} from "./quit-flow";
import {
  askIsRecording,
  captureDescendants,
  hasOnceChild,
  stopWorkerProcess,
} from "./shutdown";
import { installMenu } from "./menu";
import { createSupervisor } from "./services/supervisor";
import { verifyOwnListener as checkOwnListener } from "./services/own-listener";
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
  LaunchResult,
  ServiceId,
  ServiceStatus,
  StopOutcome,
  StopPlan,
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
/**
 * worker만의 유예. stage boundary는 31분 오디오의 STT 한가운데면 분 단위가 될 수 있고,
 * 그 경계에 닿아야 `requeue_for_shutdown`이 돌아 `attempts`가 되돌아간다 (완료 기준 P2-C5).
 * 5초를 주면 사실상 매번 유예를 넘겨 사람에게 강제 종료를 묻게 되고, 그 질문에 "예"는
 * 정확히 P2-C5가 금지하는 결과를 만든다.
 */
const WORKER_GRACE_MS = 90_000;
/** 렌더러의 라이브 중지를 기다리는 상한. 사람이 아니라 렌더러를 기다리는 시간이다. */
const HANDSHAKE_TIMEOUT_MS = 30_000;
/**
 * 렌더러에 "녹음 중인가"를 묻는 왕복의 상한. 사람이 아니라 렌더러를 기다리는 시간이라
 * 짧다 — 훅은 동기 불리언 하나를 돌려준다. 값보다 **상한이 있다는 사실**이 요구사항이다.
 */
const RENDERER_ASK_TIMEOUT_MS = 3_000;
/**
 * "종료 중" 화면을 기다리는 상한. 잎은 `win.loadFile(shell/status.html)`이고 그 프라미스는
 * **렌더러가 커밋해야** 끝난다 — 봉쇄된 렌더러 하나가 ⌘Q를 영영 못 끝나게 만드는 자리였다.
 * 침묵을 줄이려고 거는 화면이지 종료의 전제가 아니므로, 안 뜨면 로그만 남기고 지나간다.
 */
const QUIT_SCREEN_TIMEOUT_MS = 5_000;
/** 개발에서 렌더러는 Vite가 서빙한다. 그 포트는 Vite 기본값이다. */
const VITE_ORIGIN = "http://localhost:5173";

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
 * ⌘Q의 흐름과 ⌘W의 흐름이 **공유하는** 래치 한 벌. 둘은 같은 창·같은 녹음을 상대하므로 도는
 * 흐름은 언제나 0개 아니면 1개다 — 판정과 수명은 quit-flow.ts의 createFlowLatch에 있다.
 * 여기(모듈 전역)에 **한 번** 만든다. 핸들러나 openWindow 안에서 만들면 각자 따로 된 `running`을
 * 들어 두 흐름이 다시 서로를 모르게 되고, 어떤 테스트도 그것을 볼 수 없다.
 */
const flows = createFlowLatch();
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
/**
 * 종료 전에 찍어 둔 worker 자손 pid. `undefined`와 빈 Set은 **다른 뜻**이다 —
 * shutdown.ts의 knownDescendants 주석에 있다.
 *
 * 이 변수가 있는 이유(이월 결함 N2): supervisor가 먼저 죽으면 그 `--once` 자식과 그것이
 * 띄운 `mlx_lm.server`는 pid 1로 재부모화되어 **그 뒤 어떤 ppid BFS에도 보이지 않는다.**
 * stopWorkerProcess는 진입해서야 자손을 찍으므로 그 경우 빈 집합만 보고 "깨끗함"을
 * 보고했다. 살아 있을 때 찍어 두는 일은 모듈 밖에서만 할 수 있어서 이 자리에 있다.
 */
let knownWorkerDescendants: ReadonlySet<number> | undefined;

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

  // 창 닫기 ≠ 종료. 다만 창을 닫으면 렌더러가 죽어 녹음이 끊기므로, 녹음 중에만 ⌘Q와 같은
  // 확인과 같은 핸드셰이크를 건다 (스펙 §6.10). 분석 중에는 아무것도 하지 않는다 — 창을
  // 닫아도 분석은 계속되고, 그것이 이 Phase의 목적이다 (완료 기준 P2-C12).
  //
  // preventDefault는 **동기로** 불러야 하는데 "녹음 중인가"는 렌더러에 물어야 해서
  // 비동기다. 그래서 첫 close는 무조건 막고, 래치를 올린 채 판정한 뒤 다시 닫는다 —
  // 녹음 중이 아니면 그 왕복이 몇 밀리초라 사람 눈에는 그냥 닫힌 것과 같다.
  //
  // 래치는 **진입에서** 올린다. 완료 시점에만 올리면 핸드셰이크(최대 30초) 동안 창이
  // 정상 상호작용 상태라, 그때 ⌘W나 빨간 버튼을 다시 누르면 두 번째 흐름이 시작된다 —
  // 렌더러는 아직 중지 중이라 isRecording()이 또 true를 돌려주므로 **사용자가 같은
  // 질문을 두 번 받는다.** 더 나쁜 꼬리도 있다: 먼저 끝난 쪽이 창을 파괴하면 나중 쪽의
  // close()는 파괴된 BrowserWindow 호출이라 TypeError를 던지고, 그 예외는 아래 catch를
  // 타는데 catch가 **다시** 닫으므로 catch 자체가 던져 main 프로세스의 unhandled
  // rejection이 된다.
  //
  // "우리가 부른 close()"(closed)는 이 창의 사실이라 창마다 한 벌이고, "도는 흐름"(running)은
  // 종료 흐름과 공유한다 — 둘 다 flows.forWindow()가 든다. 판정은 decideCloseEvent에 있다.
  const latch = flows.forWindow();
  created.on("close", (event) => {
    const gate = latch.press();
    // 종료 경로가 닫는 창과 우리가 방금 닫기로 한 창은 건드리지 않는다. quitFlow가 이미
    // 확인도 핸드셰이크도 했고, 여기서 또 물으면 사용자가 같은 질문을 두 번 받는다.
    if (gate === "let-it-close") return;
    event.preventDefault();
    if (gate === "ignore") {
      // 흐름이 도는 중의 ⌘W. 막고 무시한다 — 통과시키면 창이 파괴돼 녹음의 꼬리를 잃고,
      // 새 흐름을 시작하면 같은 질문을 두 번 받는다. 그 흐름이 종료여도 같다(재리뷰 4의 N3).
      appendSupervisorLog(
        flows.running() === "quit"
          ? "종료를 마무리하는 중에 창 닫기를 눌렀어요 — 진행 중인 마무리를 기다립니다."
          : "창을 닫는 중에 닫기를 다시 눌렀어요 — 진행 중인 마무리를 기다립니다.",
      );
      return;
    }
    const closeNow = () => {
      latch.allow();
      // 그 사이 창이 이미 파괴됐으면 여기서 멈춘다 (겹친 흐름, 앱 종료, 크래시).
      if (created.isDestroyed()) return;
      created.close();
    };
    void runCloseFlow({
      isRecording: () => isRecordingIn(created),
      confirm: async (message) => {
        const { response } = await ask(
          {
            type: "question",
            buttons: ["닫기", "취소"],
            defaultId: 1,
            cancelId: 1,
            message: "창을 닫을까요?",
            detail: message,
          },
          created,
        );
        return response === 0;
      },
      stopRecording: () => stopRecordingIn(created),
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      log: appendSupervisorLog,
      close: closeNow,
    }).catch((e: unknown) => {
      // 여기서 삼키면 창이 영영 안 닫힌다 — preventDefault를 이미 불렀기 때문이다.
      // 핸드셰이크 실패가 종료를 막지 않는 것과 같은 규칙을 창에도 적용한다: 닫는다.
      // API는 살아 있으므로 sweeper가 90초 뒤 봉인한다. 반대 선택(창을 열어 둔다)도
      // 방어 가능해 한 번 올렸고, **한 번 실패한 모달 뒤에 사용자를 가두는 것보다 종료
      // 경로와의 일관성이 낫다**는 판정을 받았다. 다시 뒤집지 않는다.
      appendSupervisorLog(`창을 닫는 중 예외 — ${reasonOf(e)}`);
      closeNow();
    }).finally(() => {
      // **조건 없이** 내린다. "취소"면 다음 ⌘W가 다시 물어야 하고, 창을 실제로 닫았으면 이제
      // ⌘Q가 먹어야 한다 — running은 종료 흐름과 공유라, 닫힌 창이 그것을 쥔 채 사라지면
      // 앱을 영영 끌 수 없다. (예전의 `if (!closed) closing = false`를 옮기면 그 결함이다.)
      latch.settle();
    });
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

/** 앱이 소유한 worker supervisor의 핸들. 없으면(외부 채택·미기동) undefined다. */
function ownWorkerHandle() {
  return supervisor?.runtimeOf("worker")?.result?.handle ?? undefined;
}

/**
 * supervisor가 아직 살아 있는 지금 자손을 찍어 둔다. 판정(살아 있을 때만 찍는다, 실패가
 * 이전 성공을 덮지 않는다)은 shutdown.ts에 있다 — 여기 두면 어떤 테스트도 부를 수 없다.
 */
async function captureWorkerDescendants(): Promise<void> {
  const handle = ownWorkerHandle();
  knownWorkerDescendants = await captureDescendants(knownWorkerDescendants, {
    pid: () => handle?.pid,
    alive: () => handle?.alive() ?? false,
    descendants: descendantPids,
    log: appendSupervisorLog,
  });
}

/**
 * 분석 중인가 — 앱이 소유한 worker에 `--once` 자식이 있는가. 새 API 엔드포인트를 만들지
 * 않는다. 외부 worker가 하는 일은 우리가 소유하지 않으므로 판정 대상이 아니다 (스펙 §6.9).
 *
 * 판정 자체는 shutdown.ts의 hasOnceChild에 있다. 여기 남는 것은 ps 왕복뿐이다.
 */
async function isAnalysing(): Promise<boolean> {
  const pid = ownWorkerHandle()?.pid;
  if (pid === undefined) return false;
  try {
    const tree = await descendantPids(pid);
    if (tree.size === 0) return false;
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid,command"], { timeout: 2_000 });
    return hasOnceChild(stdout, tree);
  } catch {
    // 판정 도구가 실패하면 "아니오"로 본다. 확인을 못 띄우는 것이 종료를 막는 것보다 낫다.
    return false;
  }
}

/**
 * 녹음 중인가 — 렌더러의 훅에 묻는다. 캡처는 브라우저가 갖고 있으므로 렌더러만이 안다.
 *
 * 전역 `win`이 아니라 창을 받는다. 창 닫기 경로는 **닫히려는 그 창**에 물어야 하고,
 * 그 창이 전역과 다를 수 있다(더 새 창이 이미 전역을 차지했다).
 */
async function isRecordingIn(target: BrowserWindow): Promise<boolean> {
  if (target.isDestroyed()) return false;
  // 상한이 없으면 봉쇄된 렌더러 하나가 ⌘Q와 ⌘W를 통째로 막는다. 그 판정(거부는 "아니오",
  // 시간 초과는 "예")은 shutdown.ts의 askIsRecording에 있다 — 여기 두면 부를 수가 없다.
  return askIsRecording(
    () => target.webContents.executeJavaScript("Boolean(window.__damwha_desktop?.isRecording?.())"),
    {
      timeoutMs: RENDERER_ASK_TIMEOUT_MS,
      onTimeout: () =>
        appendSupervisorLog(
          `렌더러가 ${RENDERER_ASK_TIMEOUT_MS}ms 안에 "녹음 중인가"에 답하지 않았어요 — 녹음 중으로 보고 진행합니다.`,
        ),
    },
  );
}

/** 렌더러의 라이브 중지. 훅이 없거나 창이 죽었으면 성공으로 읽지 않는다. */
function stopRecordingIn(target: BrowserWindow): Promise<{ stopped: boolean; reason?: string }> {
  if (target.isDestroyed()) return Promise.resolve({ stopped: false, reason: "창이 이미 없어요." });
  return target.webContents.executeJavaScript(
    "window.__damwha_desktop?.stopLiveRecording?.() ?? {stopped:false, reason:'no-bridge'}",
  ) as Promise<{ stopped: boolean; reason?: string }>;
}

/**
 * 대화상자를 띄운다. 창이 있으면 그 창에 붙인다.
 *
 * 창이 없을 때 **띄우기는 한다** — announceRestartNotice가 같은 상황에서 띄우지 않는 것과
 * 반대인데, 둘의 성격이 다르기 때문이다(재리뷰 3 §5-2). 그쪽은 앱이 스스로 꺼내는 안내라
 * 방금 창을 닫은 사람 앞에 부모 없는 모달로 뜨면 안 되지만, 여기 셋은 **사용자가 방금 한
 * 행동(⌘Q·메뉴)에 대한 직접적인 응답**이다. 창을 닫고 Dock에서 ⌘Q를 누르는 것은 평범한
 * 경로이고, 그때 아무것도 묻지 않으면 녹음·분석 확인이 통째로 사라진다.
 */
function ask(
  options: Electron.MessageBoxOptions,
  parent: BrowserWindow | null = win,
): Promise<Electron.MessageBoxReturnValue> {
  const target = parent !== null && !parent.isDestroyed() ? parent : null;
  return target === null ? dialog.showMessageBox(options) : dialog.showMessageBox(target, options);
}

/** 종료 확인. 문구(무엇이 진행 중이고 무엇을 약속하는가)는 decideQuit이 만든다. */
async function confirmQuit(message: string): Promise<boolean> {
  const { response } = await ask({
    type: "question",
    buttons: ["종료", "취소"],
    defaultId: 1,
    cancelId: 1,
    message: "담화를 종료할까요?",
    detail: message,
  });
  return response === 0;
}

/**
 * 유예 초과. **이 앱에서 이 질문을 띄우는 곳은 여기 하나뿐이다** — 어댑터가 또 띄우면
 * 사용자가 같은 질문을 두 번 받는다. 어댑터(stopOwnWorker)는 이 콜백을 그대로 전달만 한다.
 */
async function askGraceExpired(): Promise<boolean> {
  // 지금 `--once` 자식이 있으면 정상적으로 마무리 중이라는 뜻이다. 두 경우를 한 문구로
  // 합치면 진행이 잘 되고 있는 사람에게 "응답하지 않습니다"라고 말하게 된다.
  const prompt = graceExpiryPrompt(await isAnalysing());
  const { response } = await ask({
    type: "question",
    buttons: ["계속 기다리기", "지금 강제 종료"],
    defaultId: 0,
    cancelId: 0,
    message: prompt.message,
    detail: prompt.detail,
  });
  return response === 1;
}

/** 정리하지 못한 것을 보인다. 문구는 quit-flow.ts의 leftoverNotice가 만든다. */
async function showQuitNotice(notice: QuitNotice): Promise<void> {
  await ask({
    type: "warning",
    buttons: ["확인"],
    message: notice.message,
    detail: notice.detail,
  });
}

/**
 * 앱이 소유한 worker의 종료 절차 (스펙 §6.9). 판정은 전부 shutdown.ts에 있다.
 */
function stopOwnWorker(result: LaunchResult, plan: StopPlan): Promise<StopOutcome> {
  const handle = result.handle;
  if (handle === null) return Promise.resolve({ stopped: true, leaked: [] });
  return stopWorkerProcess(handle, {
    graceMs: Math.max(plan.graceMs, WORKER_GRACE_MS),
    pollMs: 200,
    signal: (pid, sig) => {
      try {
        process.kill(pid, sig);
      } catch {
        // 이미 죽었으면 ESRCH.
      }
    },
    descendants: descendantPids,
    // 묻지 않고 감독자가 준 것을 **그대로** 넘긴다. `?? false`로 감싸지 않는다 — 이제
    // false는 "포기한다"가 아니라 "한 번 더 기다린다"라서, 물어볼 사람이 없는 호출자
    // (supervisor의 기동 실패 정리)에 그 기본값을 씌우면 아무도 답하지 않는 루프가 된다.
    // undefined를 undefined로 두는 것이 곧 "물을 데가 없으면 강제하지 않는다"다.
    onGraceExpired: plan.onGraceExpired,
    knownDescendants: knownWorkerDescendants,
    // packaged main에는 콘솔 싱크가 없다. 스냅샷 실패 기록이 사라지지 않게 로그로 보낸다.
    log: appendSupervisorLog,
  });
}

/**
 * 역순 종료 + dev의 Vite. Vite는 감독자가 모르는 자식이라 여기서 직접 내린다.
 *
 * 유예 안에 안 끝난 Vite도 결과에 실어 보낸다 — P2-C4가 세는 "앱이 만든 프로세스"에는
 * 그 node도 들어간다. 감독자의 결과만 돌려주면 dev에서 남은 Vite는 아무 데도 안 적힌다.
 */
async function stopServices(): Promise<StopOutcome> {
  const v = vite;
  vite = null;
  viteApiBase = null;
  const sup = supervisor;
  const [viteLeaked, out] = await Promise.all([
    (async (): Promise<number[]> => {
      if (v === null) return [];
      await v.stop(STOP_GRACE_MS);
      return v.alive() && v.pid !== undefined ? [v.pid] : [];
    })(),
    sup === null
      ? Promise.resolve<StopOutcome>({ stopped: true, leaked: [] })
      : sup.stopAll({ graceMs: STOP_GRACE_MS, onGraceExpired: askGraceExpired }),
  ]);
  if (viteLeaked.length === 0) return out;
  return {
    stopped: false,
    leaked: [...out.leaked, ...viteLeaked],
    detail: [out.detail, "개발 서버(Vite)가 유예 안에 끝나지 않았어요."]
      .filter((line): line is string => line !== undefined)
      .join("\n"),
  };
}

/**
 * 서비스 상태 창 (메뉴 → 서비스 → 서비스 상태). 담화 화면이 붙은 뒤에는 준비 화면이 더 이상
 * 그려지지 않으므로(shell-latch.ts) 앱을 쓰는 동안 상태를 볼 곳이 이것뿐이다.
 *
 * 수명·갱신·자동으로 띄우는 규칙은 status-window.ts에, 그리는 재료는 status-view.ts에 있다.
 * 여기 남는 것은 electron 잎과 전역을 읽는 일이다.
 */
const statusWindow = createStatusWindow<BrowserWindow>({
  create: (focus) =>
    createServicesWindow(focus, (e) => appendSupervisorLog(`상태 창을 열지 못했어요 — ${reasonOf(e)}`)),
  alive: (w) => !w.isDestroyed(),
  focus: (w) => {
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  },
  onLoad: (w, listener) => w.webContents.on("did-finish-load", listener),
  onClosed: (w, listener) => w.on("closed", listener),
  run: (w, script) => w.webContents.executeJavaScript(script),
  view: () => servicesViewNow(),
  statuses: () => supervisor?.statuses() ?? [],
  mayAutoOpen: () =>
    mayAutoOpen({
      quitting,
      hasWindow: win !== null && !win.isDestroyed(),
      rendererAttached: win !== null && !win.isDestroyed() && !mayRenderShell(attachedWindow, win),
    }),
  log: appendSupervisorLog,
});

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
 * 소유권 판정 메커니즘 (b)의 배선. 판정(우리 자식인지 보는 그 한 줄, 조회 실패를 "아니오"로
 * 닫는 규칙)은 services/own-listener.ts에 있다 — 여기 두면 electron을 값으로 import하는 이
 * 파일이라 어떤 테스트도 그것을 부를 수 없고, 술어를 `true`로 바꿔도 초록불이 유지된다
 * (재리뷰 N4). listExternalWorkers와 같은 분리다.
 */
function verifyOwnListener(port: number, childPid: number | undefined): Promise<boolean> {
  return checkOwnListener({ listeners: listenerPids, descendants: descendantPids }, port, childPid);
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
    const err = e as { stdout?: string; stderr?: string; code?: number | string };
    // `||`이지 `??`가 아니다. 실행 파일이 없으면(DOCKER_BIN이 틀림) execFile은 stderr를 **빈
    // 문자열**로 채워 거부하므로, `??`는 그 빈 문자열을 원인으로 넘겨 postgres가 원인 없는
    // "실패"로 섰다. 숫자가 아닌 code("ENOENT")도 실패다 — 0이 아니면 된다.
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr || String(e),
      code: typeof err.code === "number" ? err.code : 1,
    };
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

/** 감독자의 지금 상태를 셸 화면 한 장으로 접는다. 판정은 status-view.ts의 shellStatusFrom에 있다. */
function shellStatusOf(): ShellStatus {
  return shellStatusFrom({ statuses: supervisor?.statuses() ?? [], restartNotice, logPathOf });
}

/** 상태 창이 그릴 재료. 판정은 status-view.ts의 servicesView에 있다. */
function servicesViewNow() {
  return servicesView({ statuses: supervisor?.statuses() ?? null, restartNotice, logPathOf });
}

/**
 * 감독자의 상태 변화를 세 곳으로 보낸다 — supervisor.log, 상태 창, 아직 준비 화면이 떠 있는
 * 동안의 메인 창.
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
  // 메인 창 검사보다 **먼저** 보낸다. 상태 창은 메인 창을 닫은 뒤에도 떠 있을 수 있고, 그때
  // 아래 activeWindow는 null이다 — 뒤에 두면 창을 닫는 순간 상태 창이 얼어붙는다.
  statusWindow.onStatus(statuses);
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
  // 붙기 전에 넘어진 서비스(uv가 없으면 worker는 몇 밀리초 만에 넘어진다)는 그때 실패 화면에
  // 잠깐 보였을 뿐, 이제 어떤 화면에도 없다. 감독자는 더 낼 상태가 없어 onStatus도 다시 돌지
  // 않으므로, 붙인 직후 여기서 한 번 더 묻는다.
  statusWindow.reconsider();
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
    detail: failureDetail(what, reasonOf(e)),
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
  // 담화 화면이 붙은 뒤에도 사용자에게 닿아야 하는 안내. 아래 reattachWindow 다음에 쓴다.
  let announce: string | null = null;
  if (existing === null) {
    if (!(await createSupervisorFor(mine))) return;
  } else {
    // 재시도 전에 config.json을 다시 읽는다. 실패 화면이 "값을 고치면 다시 시도합니다"라고
    // 적는데 ctx.env가 감독자 생성 시점에 얼어붙으면 그 문장이 거짓이 된다 (완료 기준 P2-C8).
    // 실행 중에 바꿀 수 없는 키는 바꾸지 않고 안내를 돌려준다 — shellStatusOf가 그것을 화면에
    // 얹는다.
    const reloaded = reloadConfig();
    restartNotice = reloaded.notice;
    // 상태 창이 떠 있으면 거기에도 싣는다. 대화상자(아래 announce)는 그대로 둔다 — 상태 창은 열려
    // 있지 않을 수 있다.
    statusWindow.refresh();
    if (reloaded.isNew && reloaded.notice !== null) announce = reloaded.notice;
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
  // 여기까지 왔다는 것은 담화 화면이 붙었다는 뜻이고, 그 뒤로 shellStatusOf의 안내 줄은
  // **어떤 화면에도 닿지 않는다** — renderStatus는 붙은 창을 다시 그리지 않는다
  // (mayRenderShell, shell-latch.ts). 그런데 embed는 게이트가 아니라서 "API는 running,
  // embed만 failed"가 설계상 정상이고(스펙 §6.7), 그 상태에서 사용자가 고치는 값이 바로
  // EMBED_SERVICE_PORT다 — 안내가 가장 필요한 조합이 정확히 안내가 사라지는 조합이었다
  // (재재리뷰 §3-2). 사용자가 "다시 시도"를 눌러 직접 물은 질문이므로 답은 화면에 있어야
  // 한다: 네이티브 대화상자로 띄운다 (스펙 §6.11). 새 안내일 때만 띄우므로 재시도를
  // 거듭해도 모달이 쌓이지 않는다 (config-reload.ts의 isNew).
  if (announce !== null) announceRestartNotice(mine, announce);
}

/**
 * "다시 켜야 바뀌어요"를 대화상자로 띄운다. 담화 화면이 붙은 뒤에는 이것이 유일한 경로다.
 *
 * await하지 않는다. 기다리면 startServices가 사용자가 버튼을 누를 때까지 끝나지 않고,
 * start()의 직렬화 체인(starting)이 그만큼 통째로 밀린다 — 자동 재시도와 메뉴의 재시도가
 * 사람 손을 기다리게 되는 것은 답이 아니다. 대신 거부를 삼키지 않고 적는다: void 프라미스의
 * 거부는 Electron main의 uncaught exception이 된다.
 */
function announceRestartNotice(mine: number, notice: string): void {
  const options = {
    type: "info" as const,
    message: "이 값은 앱을 다시 켜야 바뀌어요",
    detail: notice,
    buttons: ["확인"],
  };
  const target = activeWindow(mine);
  // 창이 없으면 띄우지 않는다. 여기까지 오는데 창이 없는 경우는 종료 중이거나 더 새로운
  // start()가 세대를 가져간 경우뿐이고, 부모 없는 app-modal은 사용자가 방금 닫은 앱을 위해
  // 화면 한가운데 떠 버린다. 여섯 개의 다른 소비자는 모두 null을 "하지 않는다"로 읽는다 —
  // 이것만 예외였다 (재리뷰 3 §5-2). 안내는 로그에 남으므로 사라지지는 않는다.
  if (target === null) {
    appendSupervisorLog(`재시작 안내를 띄울 창이 없어요 — ${notice}`);
    return;
  }
  const shown = dialog.showMessageBox(target, options);
  void shown.catch((e: unknown) => {
    appendSupervisorLog(`재시작 안내를 띄우지 못했어요 — ${reasonOf(e)}`);
  });
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
  if (resolved === null) throw new Error(CAUSES.repoRootMissing.text);
  repoRoot = resolved;

  const dirs = searchDirs(app.getPath("home"), cfg.extraPath);
  const uv = cfg.uvBin ?? findExecutable("uv", dirs);
  const docker = cfg.dockerBin ?? findExecutable("docker", dirs);
  // 고치는 방법(설치 · DOCKER_BIN)은 reportFailure가 failureDetail로 붙인다.
  if (docker === null) throw new Error(CAUSES.dockerMissing.text);

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
      worker: { listExternal: listExternalWorkers, stop: stopOwnWorker },
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
    // activate와 같은 가드. 'closed'가 win을 null로 만들기 전에도 창은 파괴돼 있을 수 있고
    // (spawn-guard.ts), 그때 isMinimized()가 동기로 던지면 main의 uncaught exception이다.
    if (win === null || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    applyPermissionBoundary(allowedOrigins);
    installMenu({
      onRetry: () => {
        // 판정(종료 중이면 무시, 창이 없으면 창부터)은 window-flow.ts의 decideMenuRetry에 있다.
        const plan = decideMenuRetry({ quitting, hasWindow: win !== null && !win.isDestroyed() });
        if (plan === "ignore") return;
        retryCount = 0;
        cancelRetry();
        if (plan === "open-window") openWindow();
        void start();
      },
      onShowStatus: () => statusWindow.open(),
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
    // 마무리 중에는 새 창을 만들지 않는다. 자식은 어차피 되살아나지 않지만(spawn-guard가
    // quitting을 본다) "종료 중"인 앱에 준비 화면을 단 창이 뜨고, 그 창이 win이 되어
    // showQuitting·stopRecording의 대상까지 바뀐다. 있는 창을 앞으로 보내는 위 갈래는 둔다.
    if (quitting) return;
    const opened = openWindow();
    const mine = generation;
    // 서비스는 이미 떠 있다. 화면만 다시 붙인다 — 다만 **셸 화면을 먼저 건다.** 그러지 않으면
    // reattachWindow가 loadURL에 닿을 때까지 창이 빈 흰 화면이고(dev에서 Vite가 죽어 있으면
    // rendererTarget이 재기동 + waitForReady의 30초를 통째로 그렇게 돈다), 지금 서비스가 어떤
    // 상태인지도 보이지 않는다. showShell이 래치도 같이 내려 renderStatus가 이 창을 다시
    // 그릴 수 있게 된다 (완료 기준 P2-C12, 리뷰 Important-3).
    // 순서와 실패 경로는 window-flow.ts가 정한다. 잎(loadFile·loadURL·대화상자)만 여기 있다.
    // 감독자가 없는 경우(기동이 감독자를 세우기 전에 접혔다)의 복구도 거기서 정한다.
    void openWindowFlow({
      showShell: () => showShell(opened, shellStatusOf()),
      servicesRunning: () => supervisor !== null,
      start,
      attach: () => reattachWindow(mine),
      onFailure: (e) => reportFailure(mine, "창을 다시 붙이지 못했어요", e),
    }).catch((e: unknown) => {
      // 실패 처리 자체가 거부하면 여기서 멈춘다 — void 프라미스의 거부는 Electron main의
      // uncaught exception이 되고, 하필 화면이 이미 잘못된 순간에 난다.
      appendSupervisorLog(`창을 다시 붙이는 중 예외 — ${reasonOf(e)}`);
    });
  });

  // 앱이 만든 자식은 앱이 정리한다 (스펙 §6.2, P1-C5). 순서·확인·핸드셰이크는
  // quit-flow.ts가 정한다 — 여기 남는 것은 잎과, preventDefault의 짝인 app.quit()뿐이다.
  app.on("before-quit", (event) => {
    const gate = flows.quit.press();
    // 우리 자신의 app.quit()이다. 여기서 막으면 preventDefault의 짝이 사라져 앱이 창도 없이
    // 남아 다시는 끝나지 않는다.
    if (gate === "let-it-quit") return;
    event.preventDefault();
    if (gate === "ignore") {
      // 흐름이 도는 중의 ⌘Q. 통과시키면 Electron이 즉시 창을 파괴하고 프로세스를 끝내
      // 녹음의 꼬리를 잃거나(P2-C13) detached 자식을 고아로 남긴다(P1-C5·P2-C4). 새 흐름을
      // 시작하면 같은 질문을 두 번 받는다. 그 흐름이 창 닫기여도 같다(재리뷰 4의 N3) — 그때는
      // 창 닫기가 끝난 뒤 다시 누르면 된다. 판정은 quit-flow.ts의 decideQuitEvent에 있다.
      appendSupervisorLog(
        flows.running() === "close"
          ? "창을 닫는 중에 종료를 눌렀어요 — 창 닫기가 끝난 뒤 다시 종료해 주세요."
          : "종료하는 중에 종료를 다시 눌렀어요 — 진행 중인 마무리를 기다립니다.",
      );
      return;
    }
    // preventDefault를 부른 이번 종료의 짝. 통과 래치는 **여기서만** 올라간다.
    const quitNow = () => {
      flows.quit.allow();
      app.quit();
    };
    // quitting을 여기서 올리지 않는다. 확인 대화상자에서 "취소"를 고르면 앱은 계속
    // 살아야 하는데, 래치가 먼저 올라가 있으면 그 뒤로 activeWindow가 영원히 null을
    // 돌려줘(spawn-guard) 재시도도 상태 갱신도 죽는다 — 종료하지 않은 앱이 종료된 앱처럼
    // 군다. 되돌릴 수 없는 지점(beginQuit)에서 올린다.
    void runQuitFlow({
      inFlight: async () => ({
        recording: win !== null && (await isRecordingIn(win)),
        analysing: await isAnalysing(),
      }),
      confirm: confirmQuit,
      captureDescendants: captureWorkerDescendants,
      beginQuit: () => {
        quitting = true;
        cancelRetry();
      },
      // activeWindow를 쓰지 않는다 — quitting이 이미 참이라 그것은 항상 null을 돌려준다
      // (spawn-guard). 여기서 보고 싶은 것은 "지금 창이 있는가"뿐이다.
      showQuitting: () =>
        win === null || win.isDestroyed()
          ? Promise.resolve()
          : showShell(win, { state: "quitting" }),
      stopRecording: () =>
        win === null
          ? Promise.resolve({ stopped: false, reason: "창이 이미 없어요." })
          : stopRecordingIn(win),
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      screenTimeoutMs: QUIT_SCREEN_TIMEOUT_MS,
      stopServices,
      log: appendSupervisorLog,
      warn: showQuitNotice,
      quit: quitNow,
    }).catch((e: unknown) => {
      // preventDefault로 이번 종료를 막았으므로 app.quit()이 반드시 다시 불려야 한다.
      // 확인 대화상자 자체가 거부하는 경로(창이 죽는 중, 표시 실패)가 이 catch에만 걸린다 —
      // 여기서 삼키면 앱이 창도 없이 남아 첫 ⌘Q 뒤로 영영 끝나지 않는다 (Phase 1이 값을
      // 치른 자리다). 자식을 못 죽였더라도 종료는 진행한다.
      appendSupervisorLog(`종료 중 예외 — ${reasonOf(e)}`);
      quitting = true;
      quitNow();
    })
      .finally(() => {
        // "취소"를 고르면 앱은 그대로 산다. 그때 진입 래치를 내려야 다음 ⌘Q가 다시 묻는다 —
        // 올려 둔 채로 두면 사용자가 앱을 영영 끌 수 없다. 흐름이 실제로 종료로 끝났으면
        // quitAllowed가 이미 올라가 있어 이 하강은 판정에 닿지 못한다.
        flows.quit.settle();
      });
  });
}
