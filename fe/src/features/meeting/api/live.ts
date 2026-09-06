import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";

import { apiClient } from "@/shared/api/client";

import type { PostResult } from "../lib/live-recorder";
import type {
  LiveUtterance,
  MeetingStatus,
  MeetingSummary,
} from "../model/types";
import { formatClock, toMeetingSummary } from "./mappers";
import { noteQueryKey } from "./notes";
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

/**
 * 회의가 통째로 사라졌을 때(삭제, 라이브 종료 discard) 그 회의에 딸린 캐시를
 * 전부 지운다. useDeleteMeeting과 useStopLive의 discarded 분기가 "회의가
 * 더는 없다"는 같은 상황이라 이 집합을 공유한다 — 한쪽만 손보면 나머지 캐시가
 * 남아 낡은 화면과 404 폴링 루프로 이어지므로, 키 목록을 여기 한 곳에 둔다.
 */
export function removeMeetingCaches(queryClient: QueryClient, id: string) {
  queryClient.removeQueries({ queryKey: ["meeting", id] });
  queryClient.removeQueries({ queryKey: ["meeting-status", id] });
  queryClient.removeQueries({ queryKey: ["meeting-lenses", id] });
  queryClient.removeQueries({ queryKey: noteQueryKey(id) });
  queryClient.removeQueries({ queryKey: liveQueryKey(id) });
}

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

const LIVE_BINARY_HEADERS = { "Content-Type": "application/octet-stream" };

/**
 * 라이브 청크 업로드 (POST /meetings/:id/live/audio). 200과 409 둘 다 정상 흐름이다 —
 * 409의 expected_offset이 잃어버린 ACK 뒤 재동기화의 근거라, apiClient의 기본
 * 인터셉터(2xx 외 전부를 ApiError로 reject하며 몸통을 버림)를 이 요청만 우회해야
 * 그 값을 읽을 수 있다(다른 소비자는 전역 인터셉터를 그대로 탄다). LiveRecorder의
 * postChunk 계약({ok, expected})을 그대로 지킨다.
 */
export async function postLiveChunk(
  id: string,
  offset: number,
  body: Uint8Array,
  elapsedMs: number,
): Promise<PostResult> {
  const res = await apiClient.post<{ expected_offset: number }>(
    `/meetings/${id}/live/audio`,
    body,
    {
      headers: {
        ...LIVE_BINARY_HEADERS,
        "X-Audio-Offset": String(offset),
        "X-Capture-Elapsed": String(elapsedMs),
      },
      validateStatus: (s) => s === 200 || s === 409,
    },
  );
  return { ok: res.status === 200, expected: res.data.expected_offset };
}

/**
 * 라이브 종료 POST (POST /meetings/:id/live/stop). LiveRecorder.stop()의 postStop
 * 계약(Promise<void>)을 지키면서도, 서버가 돌려주는 outcome(stopping/discarded)은
 * onStopped로 곁가지 전달한다 — discarded는 회의가 통째로 사라진 것이라 캐시 정리·
 * 네비게이션이 달라야 하는데, LiveRecorder는 stop()의 반환값을 보지 않는다.
 * 409(missing_chunk)는 여기선 정상 흐름이 아니다 — stop은 끝이라 재동기화 후 재시도가
 * 없으므로, expected_offset을 메시지에 담아 던진다(인터셉터의 익명 "Invalid input"보다
 * 진단이 낫다).
 */
export async function postLiveStop(
  id: string,
  offset: number,
  final: number,
  body: Uint8Array,
  elapsedMs: number,
  onStopped?: (res: LiveStopResponse) => void,
): Promise<void> {
  const res = await apiClient.post<
    LiveStopResponse & { expected_offset?: number }
  >(`/meetings/${id}/live/stop`, body, {
    headers: {
      ...LIVE_BINARY_HEADERS,
      "X-Audio-Offset": String(offset),
      "X-Final-Offset": String(final),
      "X-Capture-Elapsed": String(elapsedMs),
    },
    validateStatus: (s) => s === 200 || s === 409,
  });
  if (res.status === 409) {
    throw new Error(
      `live stop offset mismatch, expected ${res.data.expected_offset}`,
    );
  }
  onStopped?.(res.data);
}

/**
 * 녹음 종료. 실제 POST는 이 훅이 만들지 않는다 — 종료는 브라우저 레코더가 워크릿을
 * 멈추고 버퍼를 비운 뒤 꼬리를 실어 보내야 하므로(설계 §5.4), 호출자가 그 절차
 * 전체(보통 LiveRecorder.stop())를 stop으로 넘긴다. 이 훅은 결과 outcome만 보고
 * discarded면 회의가 사라졌으니 캐시를 지운다.
 */
export function useStopLive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      stop: () => Promise<LiveStopResponse | null>;
    }) => vars.stop(),
    onSuccess: (data, vars) => {
      if (!data) return;
      if (data.outcome === "discarded") {
        removeMeetingCaches(queryClient, vars.id);
      } else {
        queryClient.invalidateQueries({ queryKey: ["meeting", vars.id] });
        queryClient.invalidateQueries({
          queryKey: ["meeting-status", vars.id],
        });
      }
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
    },
  });
}
