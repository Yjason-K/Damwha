import type { SpeakerBounds } from "../api/types";

/** 서버 상한과 동일 — 그 이상은 힌트가 아니라 오입력. */
export const SPEAKER_BOUND_MAX = 20;

/** 비어 있거나 min ≤ max면 유효. 서버도 같은 규칙으로 400을 낸다. */
export function isSpeakerBoundsValid(
  value: SpeakerBounds | undefined,
): boolean {
  if (!value) return true;
  return (
    value.min === undefined || value.max === undefined || value.min <= value.max
  );
}
