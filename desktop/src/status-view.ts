import { causeOf, hintForDetail, recoveryHint } from "./shell-hints";
import type { ShellStatus } from "./shell-window";
import type { ProcessState, ServiceId, ServiceStatus } from "./services/types";

/**
 * 감독자의 상태를 **사람이 읽는 모양**으로 접는 판정. 실패 화면(status.html)과 상태 창
 * (services.html)이 같은 이름표·같은 원인·같은 안내를 쓰도록 둘의 재료를 여기서 만든다.
 *
 * main.ts에 있던 statusLine·shellStatusOf를 옮겼다. 그 자리에 있는 동안 둘은 구조적으로
 * 무검증이었고(electron을 값으로 import하는 파일은 vitest가 못 불러온다 — shell-window.ts:4),
 * "postgres가 넘어지면 db-unreachable 화면"이라는 판정도 함께 거기 있었다. main.ts에는 전역을
 * 읽어 넘기는 잎만 남는다.
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

/** 로그 파일 이름. postgres는 컨테이너라 자기 로그 파일이 없다 — 앱의 판단 기록으로 보낸다. */
export function logIdOf(id: ServiceId): ServiceId | "supervisor" {
  return id === "postgres" ? "supervisor" : id;
}

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
export function statusLine(s: ServiceStatus): string {
  const adopted = s.process === "running" && !s.owned ? " (앱이 띄우지 않음)" : "";
  const degraded = s.health === "degraded" ? " — 동작이 제한돼요" : "";
  const shown = s.detail !== undefined && (s.process === "failed" || s.health === "degraded");
  const why = shown ? `\n    ${indent(causeWithFix(s.detail ?? "", recoveryHint(s)), "    ")}` : "";
  return `${SERVICE_LABELS[s.id]}: ${PROCESS_LABELS[s.process]}${adopted}${degraded}${why}`;
}

export interface ShellInput {
  statuses: readonly ServiceStatus[];
  restartNotice: string | null;
  logPathOf(id: ServiceId | "supervisor"): string;
}

/** 감독자의 지금 상태를 셸 화면 한 장으로 접는다. 실패가 있으면 그 원인을 머리에 세운다. */
export function shellStatusFrom(input: ShellInput): ShellStatus {
  // 화면이 "값을 고치면 다시 시도합니다"라고 적는 이상, 고쳐도 반영되지 않는 값은 화면이
  // 말해야 한다. 조용히 어긋난 채로 두는 것이 재리뷰 §4-1이 지적한 결함의 절반이다.
  const lines = [
    ...input.statuses.map(statusLine),
    ...(input.restartNotice === null ? [] : [input.restartNotice]),
  ];
  const failed = input.statuses.find((s) => s.process === "failed");
  if (failed === undefined) return { state: "starting", detail: lines.join("\n") };
  return {
    // postgres가 넘어졌으면 그 화면의 문구("데이터베이스에 연결할 수 없어요")가 맞다.
    state: failed.id === "postgres" ? "db-unreachable" : "failed",
    detail: lines.join("\n"),
    logPath: input.logPathOf(logIdOf(failed.id)),
  };
}

/**
 * 감독자를 세우기 **전의** 실패(저장소 폴더·docker 부재 같은 던지는 실패)를 화면 문구로 만든다.
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
  log: string;
}

export interface ServicesView {
  rows: ServiceRow[];
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
}

function toneOf(s: ServiceStatus, cause: string | undefined): Tone {
  if (s.process === "failed") return "fail";
  if (s.process !== "running") return "idle";
  if (s.health === "degraded") return "warn";
  // 외부에 밀려 서지 않은 worker(stand-down)는 원인이 있다 — 앱의 업로드가 처리되지 않을 수
  // 있다는 경고다. 원인 없는 채택(이미 떠 있던 컨테이너·embed)은 정상이다.
  if (!s.owned && cause !== undefined) return "warn";
  return "ok";
}

/** 상태 창 한 장의 재료. services.html의 `window.__damwha_render`가 받는 모양이다. */
export function servicesView(input: ServicesInput): ServicesView {
  const notices = [
    ...(input.statuses === null ? [NO_SERVICES_YET] : []),
    ...(input.restartNotice === null ? [] : [input.restartNotice]),
  ];
  const rows = (input.statuses ?? []).map((s): ServiceRow => {
    const cause = causeOf(s);
    const notes = [
      ...(s.process === "running" && !s.owned ? ["앱이 띄우지 않음"] : []),
      ...(s.restarts > 0 ? [`재시작 ${s.restarts}회`] : []),
    ];
    const row: ServiceRow = {
      id: s.id,
      name: SERVICE_LABELS[s.id],
      state: `${PROCESS_LABELS[s.process]}${s.health === "degraded" ? " · 동작 제한" : ""}`,
      tone: toneOf(s, cause),
      notes,
      log: input.logPathOf(logIdOf(s.id)),
    };
    const hint = recoveryHint(s);
    if (cause !== undefined) row.cause = cause;
    if (hint !== undefined) row.hint = hint;
    // 떠 있는 API에만 붙인다. 죽었거나 다시 뜨는 중이면 그 기동의 판정은 아직 없다.
    if (s.id === "api" && s.process === "running" && input.migrationCheckSkipped === true) {
      row.warning = MIGRATION_CHECK_SKIPPED_WARNING;
      if (row.tone === "ok") row.tone = "warn";
    }
    return row;
  });
  return { rows, notices };
}

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
