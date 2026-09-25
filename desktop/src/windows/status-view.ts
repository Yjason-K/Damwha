import { CAUSES, causeIn } from "../diagnostics/causes";
import {
  HF_GATE_NOT_ACCEPTED_CODE,
  HF_TOKEN_INVALID_CODE,
  isStalled,
  readinessErrorCode,
  readinessErrorMessage,
  STALL_MS,
  type ReadinessEntry,
} from "../services/model-readiness";
import { restartRefused } from "../services/supervisor";
import { causeOf, hintForDetail, HINTS, recoveryHint, RETRY_LAYERS } from "./shell-hints";
import type { ShellStatus } from "./shell-window";
import type { ProcessState, ServiceId, ServiceStatus } from "../services/types";

/**
 * 감독자의 상태를 **사람이 읽는 모양**으로 접는 판정. 실패 화면(status.html)과 상태 창
 * (services.html)이 같은 이름표·같은 원인·같은 안내를 쓰도록 둘의 재료를 여기서 만든다.
 *
 * main.ts에 있던 statusLine·shellStatusOf를 옮겼다. 그 자리에 있는 동안 둘은 구조적으로
 * 무검증이었고(electron을 값으로 import하는 파일은 vitest가 못 불러온다 — shell-window.ts:1),
 * "postgres가 넘어지면 Docker 전용 화면"이라는 판정도 함께 거기 있었다(Phase 3에서 없앴다). main.ts에는
 * 전역을 읽어 넘기는 잎만 남는다.
 */

export const SERVICE_LABELS: Record<ServiceId, string> = {
  postgres: "데이터베이스",
  api: "API",
  embed: "검색 임베딩",
  worker: "작업 처리기",
};

export const PROCESS_LABELS: Record<ProcessState, string> = {
  stopped: "대기 중",
  starting: "준비 중",
  running: "실행 중",
  failed: "실패",
};

/** 안내 줄의 머리. 실패 화면과 상태 줄이 같은 말을 쓴다. */
export const HINT_PREFIX = "해결: ";

/**
 * API가 미적용 마이그레이션 검사를 건너뛴 기동이면 api 줄에 붙는 경고. 게이트는 통과했지만
 * **검사가 돌지 않았다**는 것과 **통과했다**는 것은 다른 사실이다 (스펙 §6.7·§8, P2-C9 비고:
 * packaged 트리에 `.sql`이 빠지면 게이트가 조용히 꺼진다).
 */
export const MIGRATION_CHECK_SKIPPED_WARNING =
  "마이그레이션 검사가 돌지 않았어요. 통과한 것이 아니에요 — 적용되지 않은 마이그레이션이 있어도 앱이 알아채지 못해요. " +
  "터미널에서 `pnpm be:migrate`를 실행하면 남은 마이그레이션이 적용됩니다.";

/** 아직 감독자가 없을 때 두 화면이 말하는 것. */
export const NO_SERVICES_YET = "아직 서비스를 띄우지 않았어요. 메뉴의 서비스 > 다시 시도를 눌러 주세요.";

/** 외부 디버그 모드의 postgres 줄에 붙는 표시. 실패가 아니라 상시 경고다 (Phase 3 스펙 §6.1). */
export const EXTERNAL_DATABASE_NOTE = "외부 DB(디버깅)";

function indent(text: string, pad: string): string {
  return text.split("\n").join(`\n${pad}`);
}

/**
 * 화면에 오르는 원인 한 덩어리 — 원인 줄(들)과, 안내가 있으면 그 아래 `해결: …` 줄.
 *
 * 실패 화면으로 가는 두 길이 **이것 하나**를 쓴다: 감독자 상태에서 오는 원인(statusLine →
 * shellStatusFrom)과 감독자를 세우기 전의 예외(failureDetail). 원인 문구에서 고치는 방법을 떼어
 * HINTS로 옮겼으므로(causes.ts), 이 조립이 빠지면 화면에는 원인만 남는다 — "Docker Desktop을
 * 실행하세요"(P2-C7), "config.json의 UV_BIN·DOCKER_BIN"(P2-C8), "`pnpm be:migrate`"(P2-C9)가 전부
 * 그 줄에 있다. main.ts는 이 결과를 넘기기만 한다.
 */
export function causeWithFix(cause: string, hint: string | undefined): string {
  return hint === undefined ? cause : `${cause}\n${HINT_PREFIX}${hint}`;
}

/** 셸 화면의 서비스 한 줄. 원인이 있으면 그 아래 안내까지 붙인다. */
export function statusLine(s: ServiceStatus, externalDatabase = false): string {
  const adopted =
    s.process === "running" && !s.owned
      ? s.id === "postgres" && externalDatabase
        ? ` (${EXTERNAL_DATABASE_NOTE})`
        : " (앱이 띄우지 않음)"
      : "";
  const degraded = s.health === "degraded" ? " — 동작이 제한돼요" : "";
  const winding = s.cleaningUp === true ? " — 내리는 중" : "";
  // 어느 상태에 원인을 보일지는 causeOf 하나가 정한다. 여기서 조건을 다시 적으면 정리 중 같은
  // 새 상태가 생길 때마다 두 곳이 갈린다 (판정 R-10c). stand-down은 `adopted` 꼬리가 이미
  // 말하므로 그 줄만 따로 뺀다 — **그 빼기는 health가 ok일 때만이다.** 채택한 embed는 핸들이
  // 없어도 rt.result가 있어 재프로브를 받고(supervisor.ts의 probeHealth), 거기서 degraded가 되면
  // "앱이 띄우지 않음"이 아니라 모델·차원이 어긋났다는 원인이 사람이 읽어야 할 것이다.
  // 이 줄이 넓으면 셸은 원인도 `해결:`도 없이 "동작이 제한돼요"만 적고, 같은 상태를 조건 없이
  // causeOf에 넘기는 servicesView는 둘 다 적어 두 화면이 갈린다 (이 파일 머리의 계약).
  const cause =
    s.process === "running" && !s.owned && s.health !== "degraded" && s.cleaningUp !== true
      ? undefined
      : causeOf(s);
  const why = cause === undefined ? "" : `\n    ${indent(causeWithFix(cause, recoveryHint(s)), "    ")}`;
  return `${SERVICE_LABELS[s.id]}: ${PROCESS_LABELS[s.process]}${adopted}${degraded}${winding}${why}`;
}

export interface ShellInput {
  statuses: readonly ServiceStatus[];
  restartNotice: string | null;
  logPathOf(id: ServiceId | "supervisor"): string;
  externalDatabase?: boolean;
  configWarning?: string | null;
  /** 지금 "업데이트 전으로 되돌리기" 메뉴가 실제로 눌리는가 (Phase 6b-2 스펙 §7.1). */
  restoreAvailable?: boolean;
  /**
   * packaged 앱인가. 그렇다면 **시작 중** 화면에서 서비스 줄을 뺀다 — 사용자에게 필요한 것은 "준비 중"
   * 하나이고, 서비스 이름표는 개발자의 정보다. 실패 화면은 packaged에서도 원인 줄을 그대로 보인다
   * (그때는 그 줄이 사용자가 할 일을 말한다). 서비스 상태 창은 이 값과 무관하다.
   */
  packaged?: boolean;
}

/** 업데이트와 관계된 실패에서, 되돌리기가 실제로 가능할 때만 덧붙인다 (Phase 6b-2 스펙 §7.1). */
export const RESTORE_MENU_NOTE = "앱 메뉴 → 업데이트 전으로 되돌리기…로 업데이트 전 데이터로 돌아갈 수 있어요.";
const RESTORE_RELEVANT = new Set(["migrationFailed", "migrationsStillPending"]);

/** 감독자의 지금 상태를 셸 화면 한 장으로 접는다. 실패가 있으면 그 원인을 머리에 세운다. */
export function shellStatusFrom(input: ShellInput): ShellStatus {
  // 화면이 "값을 고치면 다시 시도합니다"라고 적는 이상, 고쳐도 반영되지 않는 값은 화면이
  // 말해야 한다. 조용히 어긋난 채로 두는 것이 재리뷰 §4-1이 지적한 결함의 절반이다.
  const serviceLines = input.statuses.map((s) => statusLine(s, input.externalDatabase === true));
  // 재시작 안내와 설정 경고는 packaged에서도 남긴다 — 서비스 진행 상황이 아니라 사람이 알아야 할 사실이다.
  const notices = [
    ...(input.restartNotice === null ? [] : [input.restartNotice]),
    ...(input.configWarning === undefined || input.configWarning === null ? [] : [input.configWarning]),
  ];
  const lines = [...serviceLines, ...notices];
  const failed = input.statuses.find((s) => s.process === "failed");
  if (failed === undefined) {
    const shown = input.packaged === true ? notices : lines;
    return shown.length === 0 ? { state: "starting" } : { state: "starting", detail: shown.join("\n") };
  }
  // Phase 2의 db-unreachable 화면("Docker Desktop이 실행 중인지 확인해 주세요")은 없다 — 앱이 Docker를 부르지 않는다.
  // 어떤 실패든 일반 실패 화면이 원인과 해결 줄을 그대로 보인다.
  const failedCause = failed.detail === undefined ? undefined : causeIn(failed.detail);
  const note =
    input.restoreAvailable === true && failedCause !== undefined && RESTORE_RELEVANT.has(failedCause)
      ? [RESTORE_MENU_NOTE]
      : [];
  return { state: "failed", detail: [...lines, ...note].join("\n"), logPath: input.logPathOf(failed.id) };
}

/**
 * 감독자를 세우기 **전의** 실패(저장소 폴더를 확인하지 못한 것 같은 던지는 실패)를 화면 문구로 만든다.
 * 서비스 상태가 없으므로 recoveryHint가 아니라 원인 문구로 안내를 고른다.
 */
export function failureDetail(what: string, reason: string): string {
  return causeWithFix(`${what}: ${reason}`, hintForDetail(reason));
}

/** 상태 창의 줄 색. 강조는 이것 하나다. */
export type Tone = "ok" | "warn" | "fail" | "idle";

export interface ServiceRow {
  id: ServiceId;
  name: string;
  /** 배지 글자. */
  state: string;
  tone: Tone;
  /** 배지 옆의 작은 사실들 — "앱이 띄우지 않음", "재시작 2회". */
  notes: string[];
  /** 원인 원문. 서브프로세스 stderr가 들어온다 — 렌더러는 반드시 글자로만 넣는다. */
  cause?: string;
  hint?: string;
  /** 실패는 아니지만 사람이 알아야 하는 것 — 검사를 건너뛴 게이트. */
  warning?: string;
  /**
   * 이 줄의 "서비스 다시 시작"이 **안 되는가** (스펙 §6.10 2층). 감독자의 `restartRefused`가
   * 그대로 실린다 — 채택한 외부 인스턴스·stand-down·정리 중 셋이 여기 걸린다. Task 11의 버튼이
   * 이 값으로 비활성을 정한다.
   */
  restartRefused?: true;
  /** 이 줄의 "서비스 다시 시작" 버튼 (스펙 §6.10 2층). 판정은 `restartButton` 하나가 한다. */
  restart: RestartButton;
  log: string;
  /** 실행 중인 내장 DB에 붙는 디버깅 접속 명령 (스펙 §6.3). 렌더러는 글자로만 넣는다. */
  command?: string;
}

/**
 * 화면의 "서비스 다시 시작" 버튼 하나 (스펙 §6.10 **2층**). 서비스 줄과 모델 줄이 같은 모양을 쓴다 —
 * 모델 다운로드가 멈췄을 때 사람이 눌러야 하는 것도 결국 그 모델을 받던 서비스다.
 *
 * `disabled`의 근거는 감독자의 `restartRefused` 하나이고, `note`가 **왜** 회색인지를 말한다. 이유를
 * 말하지 않는 회색 버튼은 "앱이 멈췄다"로 읽힌다 (판정 R-10c가 `cleaningUp`을 화면에 올린 것과 같은
 * 까닭).
 */
export interface RestartButton {
  service: ServiceId;
  label: string;
  disabled: boolean;
  note?: string;
}

/**
 * 모델 준비 한 줄 (스펙 §6.9). `app_setting.model_readiness`의 항목 하나가 여기로 온다.
 *
 * **층을 가르는 값은 `errorKind`다** — `TRANSIENT`면 1층(기다린다, 버튼 없음), 그 밖이면 2층이거나
 * 3층이다. `error` 문자열만 보고 문구를 고르지 않는다(판정 R-11a).
 */
export interface ModelRow {
  /** HF repo id. */
  key: string;
  state: string;
  tone: Tone;
  /** 진행·시도 횟수·어느 서비스가 받는가. */
  notes: string[];
  cause?: string;
  hint?: string;
  /** 2층일 때만 있다. 1층(기다린다)과 3층(회의 재처리)에는 누를 것이 없다. */
  restart?: RestartButton;
}

/**
 * 상태 창의 토큰 항목 (스펙 §6.4 — "마스킹 표시, 수정·삭제 가능").
 *
 * **원문은 어디에도 싣지 않는다.** 이 객체는 `renderCall`이 JSON으로 렌더러에 넘기고 로그에도 남을 수
 * 있으므로 `maskToken`을 지난 값만 들어온다.
 */
export interface TokenView {
  /** 가린 모양(`hf_****…****abcd`). 저장된 토큰이 없으면 null. */
  masked: string | null;
  note: string;
  /** 지울 것이 있나. 없으면 삭제 버튼을 비활성으로 그린다. */
  canClear: boolean;
  /**
   * 토큰 창이나 삭제 확인이 **지금 떠 있나**. 두 버튼을 모두 잠근다.
   *
   * 페이지가 누른 순간 스스로 잠그지만 그것만으로는 모자란다: 묻는 고리는 `handleServicesAction`이
   * 끝날 때까지(= 토큰 창이 닫힐 때까지) 막혀 있는데, 그 사이 감독자의 상태 변화가 화면을 다시
   * 그리면 잠금이 풀린다. 그때의 두 번째 클릭은 큐에 쌓였다가 첫 창이 닫히자마자 **두 번째 토큰
   * 창**을 연다. 재시작 버튼은 `restartingServices`가 같은 일을 한다.
   */
  busy: boolean;
}

export interface ServicesView {
  rows: ServiceRow[];
  /** 모델 준비 (스펙 §6.9). 받은 적도 받는 중도 아니면 빈 목록이고, 화면은 그 절을 접는다. */
  models: ModelRow[];
  token: TokenView;
  /** 서비스 한 줄에 속하지 않는 안내 — 재시작이 필요한 설정, 아직 띄우지 않음. */
  notices: string[];
}

export interface ServicesInput {
  /** null = 감독자가 아직 없다. */
  statuses: readonly ServiceStatus[] | null;
  restartNotice: string | null;
  logPathOf(id: ServiceId | "supervisor"): string;
  /** 지금 API 기동이 마이그레이션 검사를 건너뛰었다 (services/api.ts의 createMigrationCheckWatch). */
  migrationCheckSkipped?: boolean;
  externalDatabase?: boolean;
  configWarning?: string | null;
  debugCommand?: string | null;
  /**
   * 내장 postgres가 자기 로그를 쌓는 폴더 (스펙 §6.7 — 상태 창의 postgres 로그 참조는
   * `logs/postgres/`를 가리켜야 한다). row.log 자체는 그대로 `logPathOf("postgres")`
   * (기동 싱크 logs/postgres.log)로 남는다 — 이 값은 그 옆에 덧붙는 안내일 뿐이다.
   * debugCommand와 같은 길로 들어온다: main.ts가 app.getPath("userData")에서 만들고,
   * 외부 디버그 모드에서는 null이다.
   */
  postgresLogDir?: string | null;
  /**
   * `app_setting.model_readiness`를 푼 것 (스펙 §6.9). 감독자의 리더가 읽어 온 같은 값이고, 해석은
   * `services/model-readiness.ts` 하나가 한다 — 화면이 두 번째 해석을 두면 "화면에는 받는 중인데
   * 감독자는 실패로 적었다"가 생긴다. 없으면(외부 DB 모드·읽기 실패) 모델 절을 아예 그리지 않는다.
   */
  modelReadiness?: readonly ReadinessEntry[] | null;
  /** 무진행 판정의 기준 시각. 테스트가 고정하려고 열어 둔다. */
  now?: number;
  /** 지금 "서비스 다시 시작"이 도는 중인 서비스. 버튼이 죽은 것처럼 보이지 않게 진행을 보인다. */
  restarting?: readonly ServiceId[];
  /** 저장된 HF 토큰의 **가린** 모양. 없으면 null (스펙 §6.4). 원문은 여기 오지 않는다. */
  maskedToken?: string | null;
  /** 토큰 창·삭제 확인이 떠 있다. 두 버튼을 잠근다 (TokenView.busy). */
  tokenBusy?: boolean;
  /**
   * 방금 이 창에서 누른 것의 결과 — "토큰을 바꿨어요. 작업 처리기를 다시 시작했어요." 같은 한 줄.
   * 버튼이 무슨 일을 했는지(또는 못 했는지) 말하지 않으면 사람은 눌렀는데 아무 일도 안 났다고 읽는다.
   */
  actionNotice?: string | null;
}

/** 아직 토큰을 넣지 않았거나 파일을 못 읽었다. 기동 게이트가 다음 실행에 다시 묻는다. */
export const NO_TOKEN_NOTE =
  "저장된 토큰이 없어요. 다음 실행에 토큰 화면이 다시 떠요.";
/** 토큰이 있을 때. 바꾸면 무슨 일이 일어나는지를 누르기 **전에** 말한다 (스펙 §6.4 → §6.10 2층). */
export const TOKEN_NOTE =
  "토큰을 바꾸면 작업 처리기와 검색 임베딩을 다시 시작해 새 토큰으로 돌려요.";

export const RESTART_LABEL = "서비스 다시 시작";
export const RESTART_BUSY_LABEL = "다시 시작하는 중…";
/** 앱이 만들지 않은 프로세스는 앱이 내릴 수 없다 (스펙 §5·§6.10 2층). */
export const RESTART_NOT_OURS_NOTE = "앱이 띄운 서비스가 아니라 앱이 내릴 수 없어요.";
/** 두 번째 종료 신호는 정리가 아니라 강제 종료다 (causes.ts의 restartStopFailed). */
export const RESTART_CLEANING_NOTE = "내려가는 중이라 지금은 다시 시작할 수 없어요. 끝나면 앱이 다시 띄웁니다.";

/**
 * 한 서비스의 버튼. **판정처는 여기 하나다** — 감독자의 `restartRefused`가 비활성을 정하고, 진행 중인
 * 재시작이 글자를 바꾼다. 화면이 자기 조건을 따로 적으면 버튼이 켜져 있는데 눌러도 아무 일이 없는
 * 상태가 생긴다 (스펙 §6.10이 "다시 시도 하나로 뭉치지 않는다"로 막으려는 바로 그것).
 */
export function restartButton(
  s: ServiceStatus,
  restarting: readonly ServiceId[] = [],
): RestartButton {
  if (restarting.includes(s.id)) {
    return { service: s.id, label: RESTART_BUSY_LABEL, disabled: true };
  }
  if (!restartRefused(s)) return { service: s.id, label: RESTART_LABEL, disabled: false };
  return {
    service: s.id,
    label: RESTART_LABEL,
    disabled: true,
    note: s.cleaningUp === true ? RESTART_CLEANING_NOTE : RESTART_NOT_OURS_NOTE,
  };
}

function toneOf(s: ServiceStatus, cause: string | undefined): Tone {
  if (s.process === "failed") return "fail";
  if (s.process !== "running") return "idle";
  // 정리 중은 초록이 아니다. 프로세스는 아직 답하지만 앱은 그것이 끝나기를 기다리는 중이고,
  // 그동안 "서비스 다시 시작"은 거부된다 — 평범한 "실행 중"으로 보이면 안 된다 (판정 R-10c).
  if (s.cleaningUp === true) return "warn";
  if (s.health === "degraded") return "warn";
  // 외부에 밀려 서지 않은 worker(stand-down)는 원인이 있다 — 앱의 업로드가 처리되지 않을 수
  // 있다는 경고다. 원인 없는 채택(이미 떠 있던 컨테이너·embed)은 정상이다.
  if (!s.owned && cause !== undefined) return "warn";
  return "ok";
}

/**
 * `model_readiness.entries[*].writer`가 가리키는 서비스 (스펙 §6.9, 판정 R-9a). embed만 고정
 * 문자열이고 worker 쪽(worker·`--once` 자식·`llm_entry`)은 전부 `WORKER_ID`다 — 그래서 "embed가
 * 아니면 worker"가 맞다.
 */
const EMBED_WRITER = "embed";
function serviceOfWriter(writer: string): ServiceId {
  return writer === EMBED_WRITER ? "embed" : "worker";
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];
/** 사람이 읽는 크기. 소수 한 자리면 충분하다 — 이 줄은 진행을 느끼라고 있는 것이지 감사 기록이 아니다. */
export function humanBytes(n: number): string {
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)}${UNITS[unit]}`;
}

/**
 * 받는 중 한 줄의 진행. **`bytesTotal`이 0이면 "받는 중"만 말한다** (스펙 §6.9) — 모르는 총량을
 * 0으로 두고 퍼센트를 계산하면 화면이 "0%"에 영영 붙어 있는다.
 */
export function downloadProgress(e: ReadinessEntry): string {
  if (e.bytesTotal <= 0) return "받는 중";
  const pct = Math.min(100, Math.floor((e.bytesDone / e.bytesTotal) * 100));
  return `${pct}% · ${humanBytes(e.bytesDone)} / ${humanBytes(e.bytesTotal)}`;
}

/**
 * 모델 준비 줄들 (스펙 §6.9·§6.10). **세 층이 여기서 갈린다.**
 *
 * | 항목 | 화면 | 버튼 |
 * | --- | --- | --- |
 * | `ready` | "준비됨" | 없음 |
 * | `downloading`, 진행 중 | "받는 중" + 진행 | 없음 |
 * | `downloading`, 무진행 `STALL_MS` 초과 | "중단됨" + `modelDownloadStalled` | **2층** |
 * | `failed`, `TRANSIENT` | "실패" + 사유 | 없음 — **1층**(다음 처리가 이어받는다) |
 * | `failed`, 401(`hf_token_invalid`) | 토큰 재입력 안내 | 없음 — 토큰 절의 "토큰 바꾸기"가 2층이다 |
 * | `failed`, 403(`hf_gate_not_accepted`) | 수락 페이지 + **3층**(회의 재처리) | 없음 |
 * | `failed`, 그 밖·코드 없음 | 일반 PERMANENT 문구 | **2층** |
 *
 * 순서는 `errorKind` → code다 (판정 R-11a). 그 반대로 하면 TRANSIENT로 분류된 네트워크 실패의
 * 메시지에 "403"이 섞였을 때 수락 페이지를 띄운다.
 */
export function modelRows(
  entries: readonly ReadinessEntry[],
  statuses: readonly ServiceStatus[],
  now: number,
  restarting: readonly ServiceId[] = [],
): ModelRow[] {
  const buttonFor = (writer: string): RestartButton | undefined => {
    const id = serviceOfWriter(writer);
    const s = statuses.find((x) => x.id === id);
    // 감독자가 그 서비스를 모르면 누를 것이 없다 — 없는 런타임에 restartService를 걸 수 없다.
    return s === undefined ? undefined : restartButton(s, restarting);
  };

  /**
   * 2층의 안내와 버튼은 **함께 있거나 함께 없다.**
   *
   * 감독자가 아직(또는 더는) 없으면 `buttonFor`가 undefined다 — 거부된 기동 뒤 `supervisor`가
   * null인데 마지막 `model_readiness` 스냅숏은 남아 있는 창이 그렇다. 그때도 "이 줄의
   * 서비스 다시 시작을 눌러 주세요"라고 적으면 화면에 없는 버튼을 가리킨다. 그 경우의 길은
   * 메뉴의 다시 시도 하나뿐이고, `NO_SERVICES_YET`이 이미 그 말을 한다.
   */
  const layerTwo = (writer: string): { hint: string; restart?: RestartButton } => {
    const restart = buttonFor(writer);
    return restart === undefined
      ? { hint: NO_SERVICES_YET }
      : { hint: RETRY_LAYERS.service, restart };
  };

  return entries.map((e): ModelRow => {
    const notes = [
      // 조사를 붙이지 않는다 — "검색 임베딩이"와 "작업 처리기가"가 갈려 라벨마다 규칙이 달라진다.
      `받는 서비스: ${SERVICE_LABELS[serviceOfWriter(e.writer)]}`,
      ...(e.attempt > 1 ? [`${e.attempt}번째 시도`] : []),
    ];
    if (e.state === "ready") {
      return { key: e.key, state: "준비됨", tone: "ok", notes: [] };
    }
    if (e.state === "downloading") {
      if (!isStalled(e, now, STALL_MS)) {
        return { key: e.key, state: "받는 중", tone: "idle", notes: [downloadProgress(e), ...notes] };
      }
      return {
        key: e.key,
        state: "중단됨",
        tone: "warn",
        notes: [downloadProgress(e), ...notes],
        cause: CAUSES.modelDownloadStalled.text(e.key),
        ...layerTwo(e.writer),
      };
    }

    // failed. 층은 errorKind가 **먼저** 정한다.
    const message = readinessErrorMessage(e.error);
    if (e.errorKind === "TRANSIENT") {
      return {
        key: e.key,
        state: "실패",
        tone: "warn",
        notes,
        cause: CAUSES.modelDownloadFailed.text(e.key, message),
        // 1층. 버튼을 주지 않는다 — 서비스는 살아 있고 눌러 봐야 같은 자리다.
        hint: RETRY_LAYERS.download,
      };
    }
    const code = readinessErrorCode(e.error);
    if (code === HF_TOKEN_INVALID_CODE) {
      return {
        key: e.key,
        state: "실패",
        tone: "fail",
        notes,
        cause: `${CAUSES.hfTokenInvalid.text} (${e.key})`,
        hint: `${HINTS.hfTokenInvalid as string} 아래 “허깅페이스 토큰”에서 바꾸면 두 서비스가 다시 시작돼요.`,
      };
    }
    if (code === HF_GATE_NOT_ACCEPTED_CODE) {
      return {
        key: e.key,
        state: "실패",
        tone: "fail",
        notes,
        cause: `${CAUSES.hfGateNotAccepted.text} (${e.key})`,
        // 3층. Task 6이 이미 수락 페이지와 "그 회의를 다시 처리해 주세요"를 한 문장에 넣었다 —
        // 여기서 다시 적지 않는다(같은 원인을 두 곳이 쓰면 문구가 갈린다).
        hint: HINTS.hfGateNotAccepted as string,
      };
    }
    return {
      key: e.key,
      state: "실패",
      tone: "fail",
      notes,
      cause: CAUSES.modelDownloadFailed.text(e.key, message),
      ...layerTwo(e.writer),
    };
  });
}

/** 토큰 절 (스펙 §6.4). 원문은 이 함수에 들어오지 않는다 — 부르는 쪽이 이미 `maskToken`을 지났다. */
export function tokenView(masked: string | null | undefined, busy = false): TokenView {
  const value = masked ?? null;
  return {
    masked: value,
    note: value === null ? NO_TOKEN_NOTE : TOKEN_NOTE,
    // 창이 떠 있는 동안에는 지울 것이 있어도 지우지 못한다 — 그 창이 바로 그 값을 바꾸는 중이다.
    canClear: value !== null && !busy,
    busy,
  };
}

/** 상태 창 한 장의 재료. services.html의 `window.__damwha_render`가 받는 모양이다. */
export function servicesView(input: ServicesInput): ServicesView {
  const notices = [
    ...(input.statuses === null ? [NO_SERVICES_YET] : []),
    // 방금 누른 것의 결과를 맨 위에 둔다 — 그것이 지금 사람이 찾고 있는 한 줄이다.
    ...(input.actionNotice === undefined || input.actionNotice === null ? [] : [input.actionNotice]),
    ...(input.restartNotice === null ? [] : [input.restartNotice]),
    ...(input.configWarning === undefined || input.configWarning === null ? [] : [input.configWarning]),
  ];
  const external = input.externalDatabase === true;
  const rows = (input.statuses ?? []).map((s): ServiceRow => {
    const cause = causeOf(s);
    const debugDb = s.id === "postgres" && external;
    const notes = [
      ...(s.process === "running" && !s.owned ? [debugDb ? EXTERNAL_DATABASE_NOTE : "앱이 띄우지 않음"] : []),
      ...(s.restarts > 0 ? [`재시작 ${s.restarts}회`] : []),
      ...(s.id === "postgres" && !external && typeof input.postgresLogDir === "string"
        ? [`서버 로그: ${input.postgresLogDir}`]
        : []),
    ];
    const row: ServiceRow = {
      id: s.id,
      name: SERVICE_LABELS[s.id],
      state: `${PROCESS_LABELS[s.process]}${s.health === "degraded" ? " · 동작 제한" : ""}${
        s.cleaningUp === true ? " · 정리 중" : ""
      }`,
      tone: toneOf(s, cause),
      notes,
      restart: restartButton(s, input.restarting ?? []),
      log: input.logPathOf(s.id),
    };
    // "서비스 다시 시작" 버튼의 활성 여부 (스펙 §6.10 2층, Task 11이 쓴다). 술어는 감독자의
    // `restartRefused` **하나**다 — 화면이 자기 조건을 따로 적으면 버튼이 켜져 있는데 눌러도
    // 아무 일이 없는 상태가 생긴다.
    if (restartRefused(s)) row.restartRefused = true;
    const hint = recoveryHint(s);
    if (cause !== undefined) row.cause = cause;
    if (hint !== undefined) row.hint = hint;
    // 떠 있는 API에만 붙인다. 죽었거나 다시 뜨는 중이면 그 기동의 판정은 아직 없다.
    if (s.id === "api" && s.process === "running" && input.migrationCheckSkipped === true) {
      row.warning = MIGRATION_CHECK_SKIPPED_WARNING;
      if (row.tone === "ok") row.tone = "warn";
    }
    if (debugDb && s.process === "running") {
      // 제품 경로가 아니다. 사용자가 Docker DB를 쓰고 있다는 사실을 상태 창이 치우지 않는다 (R3-14).
      row.warning = CAUSES.externalDatabase.text;
      row.tone = "warn";
    }
    if (s.id === "postgres" && !external && s.process === "running" && typeof input.debugCommand === "string") {
      row.command = input.debugCommand;
    }
    return row;
  });
  const statuses = input.statuses ?? [];
  return {
    rows,
    models: modelRows(
      input.modelReadiness ?? [],
      statuses,
      input.now ?? Date.now(),
      input.restarting ?? [],
    ),
    token: tokenView(input.maskedToken, input.tokenBusy === true),
    notices,
  };
}

/** 상태 창이 main에게 보내는 것 — **이 둘뿐이다** (parseServicesAction이 그것을 강제한다). */
export type ServicesAction =
  | { kind: "restart"; service: ServiceId }
  | { kind: "token"; op: "change" | "clear" };

const TOKEN_OPS: readonly string[] = ["change", "clear"];

/**
 * 페이지가 보낸 값. **렌더러 데이터이므로 모양을 확인하고, 모르는 것은 null이다** —
 * `windows/token-window.ts`의 `parseAction`과 같은 규칙이고 같은 이유다: 상태 창에서 오는 값이
 * 서비스 id가 되어 감독자에게 그대로 들어가면 안 된다.
 */
export function parseServicesAction(raw: unknown): ServicesAction | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { kind?: unknown; service?: unknown; op?: unknown };
  if (r.kind === "restart") {
    return typeof r.service === "string" &&
      Object.prototype.hasOwnProperty.call(SERVICE_LABELS, r.service)
      ? { kind: "restart", service: r.service as ServiceId }
      : null;
  }
  if (r.kind === "token") {
    return typeof r.op === "string" && TOKEN_OPS.includes(r.op)
      ? { kind: "token", op: r.op as "change" | "clear" }
      : null;
  }
  return null;
}

/**
 * 페이지에 다음 동작을 묻는 식. 다리가 없으면(스크립트가 안 돌았다) null이다 — token-window.ts의
 * `ASK_SCRIPT`와 같은 모양이고, 같은 이유로 **렌더러 → main 채널이 아니다**: 반환값은 main이 건
 * 호출의 결과다 (스펙 §6.11 — preload도 IPC도 없다).
 */
export const SERVICES_ASK_SCRIPT =
  "window.__damwha_services ? window.__damwha_services.next() : null";

/**
 * main → 상태 창의 한 방향 호출문 (스펙 §6.11). 재로드가 아니라 함수 호출이라 갱신마다 창이
 * 깜빡이지 않는다.
 *
 * 값은 JSON.stringify로만 싣는다. JSON은 ES2019부터 JS 식의 부분집합이라(U+2028/2029 포함)
 * 원인 문구에 따옴표·괄호·`</script>`가 있어도 문자열 리터럴 밖으로 나가지 못한다 — 문자열을
 * 이어 붙여 식을 만들면 stderr 한 줄이 main이 렌더러에서 실행하는 코드가 된다.
 *
 * `void`로 감싸는 이유: executeJavaScript는 식의 값을 main으로 직렬화해 돌려준다. 렌더 함수가
 * 실수로 DOM 노드를 돌려주면 그 직렬화가 실패해 호출 전체가 거부된다.
 */
export function renderCall(view: ServicesView): string {
  return `void window.__damwha_render?.(${JSON.stringify(view)});`;
}
