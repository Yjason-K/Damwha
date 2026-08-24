import { formatClock } from "@/features/meeting/api/mappers";
import type { LensWireItem } from "../model/types";

export type LensItemView = {
  source: "ai" | "user" | "edited" | "hint";
  primary: { utteranceId: string; startMs: number } | null;
  timecode: string | null;
};

export function mapItemView(item: LensWireItem): LensItemView {
  const primaryEv = item.evidence.find((e) => e.relation === "primary") ?? null;
  const primary = primaryEv
    ? {
        utteranceId: primaryEv.utterance.id,
        startMs: primaryEv.utterance.start_ms,
      }
    : null;
  // 근거가 사라진 보존 AI 항목 → "확인 필요"(품질조건). 사용자/수정 항목은 유지.
  const source = item.source === "ai" && !primary ? "hint" : item.source;
  return {
    source,
    primary,
    timecode: primary ? formatClock(primary.startMs) : null,
  };
}
