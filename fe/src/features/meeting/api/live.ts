import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";

import { apiClient } from "@/shared/api/client";

import type {
  LiveUtterance,
  MeetingStatus,
  MeetingSummary,
} from "../model/types";
import { formatClock, toMeetingSummary } from "./mappers";
import type {
  LiveStartRequest,
  LiveStopResponse,
  WireLiveResponse,
  WireLiveUtterance,
  WireMeeting,
} from "./types";

/**
 * 라이브 세션 데이터 레이어 (설계 §7.1). 상세 캐시(["meeting", id])와 분리한 이유는
 * 메모와 같다 — 1초마다 상세를 갈아 끼우면 그 캐시를 구독하는 화면 전체가 리렌더된다.
 */

export const liveQueryKey = (id: string) => ["live-utterances", id] as const;

export type LiveState = {
  status: MeetingStatus;
  stage: string | null;
  heartbeatAt: string | null;
  items: LiveUtterance[];
};

function toLiveUtterance(w: WireLiveUtterance): LiveUtterance {
  return {
    id: w.id,
    seq: w.seq,
    t: formatClock(w.start_ms),
    startMs: w.start_ms,
    text: w.text,
    speakerName: w.speaker_name,
    similarity: w.similarity,
  };
}

/** 상태별 폴링 간격. failed는 한 번만(보존된 미리보기), done은 조회 자체를 안 한다. */
function intervalFor(status: MeetingStatus | undefined): number | false {
  if (status === "recording") return 1000;
  if (status === "uploaded" || status === "processing") return 3000;
  return false;
}

/**
 * 라이브 발화. 마지막 seq를 `after`로 넘겨 새 행만 받아 append한다 — 응답은 늘
 * 새 행 몇 개뿐이다. 탭이 뒤로 가면 TanStack Query 기본대로 멈췄다가 복귀 시 커서로
 * 따라잡는다.
 */
export function useLiveUtterances(
  id: string | undefined,
  status: MeetingStatus | undefined,
): UseQueryResult<LiveState> {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: liveQueryKey(id ?? ""),
    enabled: !!id && status !== undefined && status !== "done",
    queryFn: async () => {
      const prev = queryClient.getQueryData<LiveState>(liveQueryKey(id ?? ""));
      const last = prev?.items.length
        ? prev.items[prev.items.length - 1].seq
        : undefined;
      const { data } = await apiClient.get<WireLiveResponse>(
        `/meetings/${id}/live`,
        { params: last === undefined ? undefined : { after: last } },
      );
      const fresh = data.items.map(toLiveUtterance);
      return {
        status: data.status,
        stage: data.stage,
        heartbeatAt: data.heartbeat_at,
        items: last === undefined ? fresh : [...(prev?.items ?? []), ...fresh],
      };
    },
    refetchInterval: () => intervalFor(status),
  });
}

/** 녹음 시작 (POST /meetings/live). 성공하면 목록을 무효화한다. */
export function useStartLive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: LiveStartRequest): Promise<MeetingSummary> => {
      const { data } = await apiClient.post<WireMeeting>(
        "/meetings/live",
        vars,
      );
      return toMeetingSummary(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
    },
  });
}

/** 녹음 종료 (POST /meetings/:id/live/stop). discarded면 회의가 사라졌으니 캐시를 지운다. */
export function useStopLive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await apiClient.post<LiveStopResponse>(
        `/meetings/${id}/live/stop`,
      );
      return data;
    },
    onSuccess: (data, id) => {
      if (data.outcome === "discarded") {
        queryClient.removeQueries({ queryKey: ["meeting", id] });
        queryClient.removeQueries({ queryKey: ["meeting-status", id] });
        queryClient.removeQueries({ queryKey: liveQueryKey(id) });
      } else {
        queryClient.invalidateQueries({ queryKey: ["meeting", id] });
        queryClient.invalidateQueries({ queryKey: ["meeting-status", id] });
      }
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
    },
  });
}
