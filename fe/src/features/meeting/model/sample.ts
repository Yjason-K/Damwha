import type { Meeting } from "./types";

/** 샘플 한 개의 최대 길이(초). 화자를 알아보기엔 충분하고, 팝업에서 듣기엔 짧다. */
const SAMPLE_MAX_SECONDS = 8;

export type Sample = { start: number; end: number };

/**
 * 화자(spk)의 타임라인 구간 중 가장 긴 것을 골라 초 단위로 돌려준다.
 * 트랙 구간은 0–1 비율이라 totalSeconds로 되돌린다. 구간이 없거나 길이를
 * 모르면 null — 이때는 버튼 자체를 숨긴다.
 */
export function pickSample(meeting: Meeting, spk: number): Sample | null {
  const total = meeting.totalSeconds;
  if (!(total > 0)) return null;
  const lane = meeting.tracks?.find((t) => t.spk === spk);
  if (!lane) return null;
  let best: { start: number; end: number } | null = null;
  for (const seg of lane.segments) {
    if (!best || seg.end - seg.start > best.end - best.start) best = seg;
  }
  if (!best || best.end <= best.start) return null;
  const start = best.start * total;
  const end = Math.min(best.end * total, start + SAMPLE_MAX_SECONDS);
  return { start, end };
}
