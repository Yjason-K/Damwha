import { CAUSES } from "../diagnostics/causes";
import { restartRefused } from "../services/supervisor";
import { causeOf, hintForDetail, recoveryHint } from "./shell-hints";
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
  // 말하므로 그 줄만 따로 뺀다.
  const cause = s.process === "running" && !s.owned && s.cleaningUp !== true ? undefined : causeOf(s);
  const why = cause === undefined ? "" : `\n    ${indent(causeWithFix(cause, recoveryHint(s)), "    ")}`;
  return `${SERVICE_LABELS[s.id]}: ${PROCESS_LABELS[s.process]}${adopted}${degraded}${winding}${why}`;
}

export interface ShellInput {
  statuses: readonly ServiceStatus[];
  restartNotice: string | null;
  logPathOf(id: ServiceId | "supervisor"): string;
  externalDatabase?: boolean;
  configWarning?: string | null;
}

/** 감독자의 지금 상태를 셸 화면 한 장으로 접는다. 실패가 있으면 그 원인을 머리에 세운다. */
export function shellStatusFrom(input: ShellInput): ShellStatus {
  // 화면이 "값을 고치면 다시 시도합니다"라고 적는 이상, 고쳐도 반영되지 않는 값은 화면이
  // 말해야 한다. 조용히 어긋난 채로 두는 것이 재리뷰 §4-1이 지적한 결함의 절반이다.
  const lines = [
    ...input.statuses.map((s) => statusLine(s, input.externalDatabase === true)),
    ...(input.restartNotice === null ? [] : [input.restartNotice]),
    ...(input.configWarning === undefined || input.configWarning === null ? [] : [input.configWarning]),
  ];
  const failed = input.statuses.find((s) => s.process === "failed");
  if (failed === undefined) return { state: "starting", detail: lines.join("\n") };
  // Phase 2의 db-unreachable 화면("Docker Desktop이 실행 중인지 확인해 주세요")은 없다 — 앱이 Docker를 부르지 않는다.
  // 어떤 실패든 일반 실패 화면이 원인과 해결 줄을 그대로 보인다.
  return { state: "failed", detail: lines.join("\n"), logPath: input.logPathOf(failed.id) };
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
  log: string;
  /** 실행 중인 내장 DB에 붙는 디버깅 접속 명령 (스펙 §6.3). 렌더러는 글자로만 넣는다. */
  command?: string;
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

/** 상태 창 한 장의 재료. services.html의 `window.__damwha_render`가 받는 모양이다. */
export function servicesView(input: ServicesInput): ServicesView {
  const notices = [
    ...(input.statuses === null ? [NO_SERVICES_YET] : []),
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
