import type { ModelReadiness, ModelReadinessEntry } from "../api/types";

/**
 * `GET /settings/processing`이 얹어 주는 모델 준비 상태를 화면이 읽는 규칙 (Phase 4 스펙 §6.9).
 *
 * 이 값을 쓰는 이유는 하나다: **왜 지금 이런가**를 말하기 위해서다. bge-m3를 받는 동안 검색은
 * 키워드로만 돌고, 처리 중인 회의는 모델을 받느라 한참 멈춰 있는 것처럼 보인다. 이유를 말하지
 * 않으면 둘 다 "망가졌다"로 읽힌다.
 *
 * 여기 있는 것은 전부 순수 함수다 — 시각을 인자로 받아 테스트가 고정한다.
 */

/**
 * 진행이 이만큼 멈춰 있으면 "받는 중"으로 쳐 주지 않는다. 앱 상태 창의 `STALL_MS`
 * (`desktop/src/services/model-readiness.ts`)와 **같은 값**이다 — 두 화면이 같은 행을 보는데
 * 기준이 다르면 한쪽은 진행 중, 다른 쪽은 중단됨을 보인다.
 */
export const MODEL_STALL_MS = 120_000;

/**
 * `model_readiness.entries[*].writer`가 검색 임베딩 서비스에 다는 이름. worker 쪽 writer는 워커
 * id라 값이 실행마다 다르고, embed만 이 고정 문자열이다 (스펙 §6.9, 판정 R-9a).
 *
 * 모델 이름(`BAAI/bge-m3`)으로 가르지 않는 이유: 그 이름은 BE의 `SEARCH_EMBEDDING_MODEL` 환경
 * 변수라 사람이 바꿀 수 있고, FE가 베껴 두면 바뀐 날 조용히 틀린다.
 */
const EMBED_WRITER = "embed";

function updatedMs(e: ModelReadinessEntry): number | null {
  if (e.updatedAt === null) return null;
  const t = Date.parse(e.updatedAt);
  return Number.isNaN(t) ? null : t;
}

/**
 * 지금 **정말** 받는 중인가. `state`만 보지 않는다 — 받다가 죽은 프로세스는 `downloading`을 그대로
 * 남기고, writer가 그것을 치워 주기를 기대할 수 없다 (스펙 §6.9).
 */
export function isDownloadingModel(e: ModelReadinessEntry, now: number): boolean {
  if (e.state !== "downloading") return false;
  const at = updatedMs(e);
  // 읽을 수 없는 시각은 "받는 중"이 아니다. 모르는 값이 진행을 **길게** 보이는 쪽으로 기울면
  // 영영 사라지지 않는 진행 표시가 남는다.
  return at !== null && now - at <= MODEL_STALL_MS;
}

/** 지금 받는 중인 모델들. 화면이 처리 배너에 그대로 싣는다. */
export function downloadingNow(
  readiness: ModelReadiness | undefined,
  now: number,
): ModelReadinessEntry[] {
  return (readiness?.entries ?? []).filter((e) => isDownloadingModel(e, now));
}

/**
 * 검색이 **키워드로만** 도는가. 검색 임베딩 서비스가 쓰는 항목이 `ready`가 아니면 그렇다 —
 * 받는 중이든, 멈췄든, 실패했든 그 모델 없이는 의미 검색이 안 된다.
 *
 * 행이 없으면 거짓이다. "아직 아무도 아무것도 안 받았다"는 **모른다**는 뜻이고(모델이 이미
 * 캐시에 있으면 worker는 아무것도 쓰지 않는다), 모르는 것을 "안 된다"로 말하면 멀쩡한 검색에
 * 경고가 상시로 붙는다.
 *
 * 시각을 보지 않는다 — 받는 중이든 멈췄든 실패했든 답은 같다. 무진행 판정이 필요한 곳은
 * "지금 받는 중"을 말하는 `downloadingNow` 쪽이다.
 */
export function searchIsKeywordOnly(readiness: ModelReadiness | undefined): boolean {
  return (readiness?.entries ?? []).some(
    (e) => e.writer === EMBED_WRITER && e.state !== "ready",
  );
}

/**
 * 받는 중 한 줄. **`bytesTotal`이 0이면 퍼센트를 지어내지 않는다** (스펙 §6.9) — 모르는 총량으로
 * 계산한 0%는 영영 0%다.
 */
export function modelProgressLabel(e: ModelReadinessEntry): string {
  if (e.bytesTotal <= 0) return e.key;
  const pct = Math.min(100, Math.floor((e.bytesDone / e.bytesTotal) * 100));
  return `${e.key} ${pct}%`;
}
