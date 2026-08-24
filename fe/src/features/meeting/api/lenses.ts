import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import type { LensWireItem } from "@/features/lens/model/types";

/** 이 회의의 현재 처리 버전에서 마지막 추출 run의 상태. null = 돌린 적 없음. */
export type LensExtractionStatus = "queued" | "running" | "done" | "failed";

export type MeetingLenses = {
  items: LensWireItem[];
  extractionStatus: LensExtractionStatus | null;
};

/**
 * 회의 1건의 활성 렌즈 항목 + 추출 상태 (GET /meetings/:id/lenses).
 * 추출이 큐에 있거나 도는 동안에는 5초 간격으로 다시 읽는다 — 미뤄둔 추출을
 * 사용자가 직접 걸었을 때 결과가 저절로 채워져야 한다.
 */
export function useMeetingLenses(
  meetingId: string | undefined,
): UseQueryResult<MeetingLenses> {
  return useQuery({
    queryKey: ["meeting-lenses", meetingId],
    queryFn: async () => {
      const { data } = await apiClient.get<{
        items: LensWireItem[];
        extraction_status: LensExtractionStatus | null;
      }>(`/meetings/${meetingId}/lenses`);
      return { items: data.items, extractionStatus: data.extraction_status };
    },
    enabled: !!meetingId,
    refetchInterval: (query) => {
      const status = query.state.data?.extractionStatus;
      return status === "queued" || status === "running" ? 5000 : false;
    },
  });
}
