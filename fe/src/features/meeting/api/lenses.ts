import * as React from "react";
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import type { LensWireItem } from "@/features/lens/model/types";
import type { MeetingStatus } from "@/features/meeting/model/types";

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
 *
 * 워커는 회의를 done으로 넘기는 persist 트랜잭션에서 렌즈 run을 함께 큐에 넣는다.
 * 처리 중에 받은 첫 응답은 extraction_status가 null이라 폴링이 꺼져 있으므로,
 * 회의가 done으로 넘어오는 순간 한 번 다시 읽어 그 run을 집어 든다 — 그 뒤로는
 * 위 폴링이 queued/running을 따라간다. 요약 상태 변화에 기대면 요약을 미룬
 * 회의에서는 아무도 다시 읽지 않는다.
 */
export function useMeetingLenses(
  meetingId: string | undefined,
  meetingStatus?: MeetingStatus,
): UseQueryResult<MeetingLenses> {
  const queryClient = useQueryClient();
  const prevStatus = React.useRef(meetingStatus);
  React.useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = meetingStatus;
    if (!meetingId || meetingStatus !== "done") return;
    if (prev === undefined || prev === "done") return;
    queryClient.invalidateQueries({ queryKey: ["meeting-lenses", meetingId] });
  }, [meetingId, meetingStatus, queryClient]);

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
