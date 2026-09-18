/**
 * `app_setting.model_readiness` 해석 (Phase 4 스펙 §6.9). **순수하다** — DB도 프로세스도 모른다.
 *
 * 그 행을 쓰는 것은 worker·embed·`llm_entry` 셋이고(`be/worker/damwha_worker/db/core.py`의
 * `merge_model_readiness`), 앱은 읽기만 한다. 읽는 경로가 둘이라 이 모듈이 따로 있다: 감독자의
 * 준비 유예(아래 `downloadInProgress`)와 상태 창·FE의 진행 표시. 둘이 같은 해석을 써야
 * "화면에는 받는 중인데 감독자는 실패로 적었다"가 생기지 않는다.
 *
 * 들어오는 값은 **남이 쓴 jsonb**다 — 손으로 넣은 스칼라, 옛 스키마, 읽다 만 문자열이 올 수
 * 있다. 그래서 이 모듈의 두 함수는 **던지지 않는다.** 알아볼 수 없는 것은 조용히 버린다.
 */

/**
 * 진행이 이만큼 멈춰 있으면 "받는 중"으로 쳐 주지 않는다 (스펙 §6.9 — 무진행 120초).
 *
 * worker 쪽 다운로드에는 이보다 **짧은** 90초 무진행 감시가 따로 있다
 * (`be/worker/damwha_worker/config.py`의 `HF_STALL_SECONDS`, Task 9b). 워커가 언제나 자기
 * 다운로드를 먼저 끝내므로 둘이 같은 다운로드를 두 번 죽이지 않는다 — 30초가 그 여유다.
 */
export const STALL_MS = 120_000;

/**
 * 그 행의 `app_setting.key`. 원본은 `be/worker/damwha_worker/db/core.py`의 같은 이름이다.
 * 읽는 배선(main.ts의 psql)이 이 이름을 쓰는데, 그 파일은 vitest가 부르지 못하므로 문자열을
 * 거기 두면 오타가 테스트에 안 걸린다.
 */
export const MODEL_READINESS_KEY = "model_readiness";

export interface ReadinessEntry {
  /** `entries` 맵의 key. HF repo id다. */
  key: string;
  state: "downloading" | "ready" | "failed";
  bytesDone: number;
  /** 모르는 구간은 0이다. 진행 판정은 이 값이 아니라 `updatedAt`으로 한다 (스펙 §6.9). */
  bytesTotal: number;
  startedAt: number;
  updatedAt: number;
  /** 어느 프로세스가 받고 있나 — worker·`llm_entry`는 `WORKER_ID`, embed는 `"embed"` (R-9a). */
  writer: string;
  attempt: number;
  error: string | null;
  errorKind: "PERMANENT" | "TRANSIENT" | null;
}

const STATES: readonly string[] = ["downloading", "ready", "failed"];
const ERROR_KINDS: readonly string[] = ["PERMANENT", "TRANSIENT"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * worker가 쓰는 고정 정밀도 UTC 문자열(`%Y-%m-%dT%H:%M:%S.%fZ`)을 ms로. 마이크로초 여섯 자리는
 * Date.parse가 ms까지만 읽는다 — 이 판정의 단위가 초라 잘림은 무해하다.
 *
 * 읽을 수 없으면 0이다. 0은 1970년이라 어떤 stallMs로 재도 "멈춘 지 오래"가 되고, 그래서
 * 알아볼 수 없는 시각이 유예를 **늘리는** 쪽으로는 절대 기울지 않는다.
 */
function ms(v: unknown): number {
  if (typeof v !== "string") return 0;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * 저장된 jsonb(또는 그것을 읽어 온 **텍스트**)를 항목 목록으로. 알아볼 수 없으면 빈 목록이다.
 *
 * 텍스트도 받는 이유: 감독자의 리더는 번들 `psql`이라 돌려주는 것이 문자열이다(main.ts의 배선,
 * R-P8). 그 JSON.parse를 main.ts에 두면 어떤 테스트도 그것을 못 본다 — 여기가 유일한 해석처다.
 */
export function parseModelReadiness(json: unknown): ReadinessEntry[] {
  let value = json;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!isObject(value)) return [];
  const entries = value.entries;
  if (!isObject(entries)) return [];

  const out: ReadinessEntry[] = [];
  for (const [key, raw] of Object.entries(entries)) {
    if (!isObject(raw)) continue;
    const state = raw.state;
    // 모르는 state는 버린다. 채워 넣을 기본값이 없다 — "받는 중"으로 읽으면 유예가 늘고
    // "실패"로 읽으면 멀쩡한 준비를 실패로 적는다.
    if (typeof state !== "string" || !STATES.includes(state)) continue;
    out.push({
      key,
      state: state as ReadinessEntry["state"],
      bytesDone: num(raw.bytes_done, 0),
      bytesTotal: num(raw.bytes_total, 0),
      startedAt: ms(raw.started_at),
      updatedAt: ms(raw.updated_at),
      writer: typeof raw.writer === "string" ? raw.writer : "",
      attempt: num(raw.attempt, 1),
      error: typeof raw.error === "string" ? raw.error : null,
      errorKind:
        typeof raw.error_kind === "string" && ERROR_KINDS.includes(raw.error_kind)
          ? (raw.error_kind as ReadinessEntry["errorKind"])
          : null,
    });
  }
  return out;
}

/**
 * `writer`가 **지금** 받고 있나. 감독자와 `llm_server._wait_ready`가 같은 규칙을 각각 쓴다
 * (스펙 §6.9 — "두 곳에서 따로").
 *
 * - 판정은 `bytesDone` 증가가 아니라 **`updatedAt`**이다. `bytesTotal`을 모르는 다운로드가 있고,
 *   그럴 때 바이트만 보면 진행 중인 것을 멈춘 것으로 본다.
 * - **`writer`로 서비스를 구별한다.** 다른 서비스가 받는 모델 때문에 이 서비스의 유예가 늘어나면
 *   안 된다 — embed가 죽어 가는 동안 worker가 whisper를 받고 있으면 embed의 시계가 멈춘 채로
 *   영영 안 죽는다.
 */
export function downloadInProgress(
  entries: readonly ReadinessEntry[],
  writer: string,
  now: number,
  stallMs: number,
): boolean {
  return entries.some(
    (e) => e.state === "downloading" && e.writer === writer && now - e.updatedAt <= stallMs,
  );
}
