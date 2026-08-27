import type { UtteranceEntry } from "./types";

/**
 * 재생 위치 ↔ 발언 블록 매핑. 블록의 시각은 첫 원본 발화의 startMs다.
 */
const REWIND_GRACE_MS = 1_500;

function startOf(u: UtteranceEntry) {
  return u.sources[0]?.startMs ?? 0;
}

function sortedByStart(utterances: readonly UtteranceEntry[]) {
  return [...utterances].sort((a, b) => startOf(a) - startOf(b));
}

/** currentMs 이전(또는 같은 시각)에 시작한 마지막 블록의 index — 없으면 -1. */
function currentIndex(sorted: readonly UtteranceEntry[], currentMs: number) {
  let idx = -1;
  for (let i = 0; i < sorted.length; i += 1) {
    if (startOf(sorted[i]) <= currentMs) idx = i;
  }
  return idx;
}

/** 지금 재생 중인(=현재 시각을 포함하는) 블록의 id. */
export function currentUtterance(
  utterances: readonly UtteranceEntry[],
  currentMs: number,
): string | null {
  const sorted = sortedByStart(utterances);
  return sorted[currentIndex(sorted, currentMs)]?.id ?? null;
}

/**
 * 이전/다음 블록의 id. prev는 음악 플레이어 관례를 따른다 — 현재 블록에
 * 들어온 지 REWIND_GRACE_MS가 지났으면 현재 블록 처음으로, 아니면 이전 블록으로.
 */
export function adjacentUtterance(
  utterances: readonly UtteranceEntry[],
  currentMs: number,
  dir: "prev" | "next",
): string | null {
  const sorted = sortedByStart(utterances);
  if (dir === "next") {
    return sorted.find((u) => startOf(u) > currentMs)?.id ?? null;
  }
  const idx = currentIndex(sorted, currentMs);
  if (idx < 0) return null;
  const current = sorted[idx];
  if (currentMs - startOf(current) >= REWIND_GRACE_MS) return current.id;
  return sorted[idx - 1]?.id ?? null;
}
