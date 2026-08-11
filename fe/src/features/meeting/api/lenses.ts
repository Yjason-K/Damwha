import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import type { LensWireItem } from "@/features/lens/model/types";

/** 회의 1건의 활성 렌즈 항목 (GET /meetings/:id/lenses). */
export function useMeetingLenses(
  meetingId: string | undefined,
): UseQueryResult<LensWireItem[]> {
  return useQuery({
    queryKey: ["meeting-lenses", meetingId],
    queryFn: async () => {
      const { data } = await apiClient.get<{ items: LensWireItem[] }>(
        `/meetings/${meetingId}/lenses`,
      );
      return data.items;
    },
    enabled: !!meetingId,
  });
}
