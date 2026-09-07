import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";

import { apiClient } from "@/shared/api/client";

import {
  LiveUploadRejected,
  type PostResult,
  type RecorderFailure,
} from "../lib/live-recorder";
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
 * 한 요청의 상한 (설계 §7). 응답 없는 소켓 하나가 in-flight 슬롯을 영원히 물고 있으면
 * 큐는 60초 상한까지 부풀고, 정상 stop의 drain은 끝날 수가 없다 — 각 시도를 잘라 내야
 * 재전송 루프가 돈다. axios는 signal이 abort되면 요청을 취소하고 reject하므로,
 * 레코더 입장에선 여느 네트워크 실패와 같은 모양(같은 청크 재전송)이 된다.
 */
const REQUEST_TIMEOUT_MS = 10_000;

type LiveBoundaryResponse = {
  expected_offset?: number;
  code?: string;
};

/** 서버가 스스로 봉인했다는 코드. 그 밖의 code는 재동기화용 409의 부가 정보다. */
const SERVER_SEALS = ["sealed", "duration_limit"] as const;

/**
 * 200/409 응답을 레코더의 판정 단위(PostResult)로 바꾼다.
 *
 * 409는 "여기서부터 다시 보내라"일 때만 정상 흐름이다. 종단 상태의 409(회의가 더는
 * recording이 아님, io_error)는 오프셋을 싣지 않는데, 그 값을 그대로 받으면
 * this.offset = undefined → "X-Audio-Offset: undefined" → 400 → 무한 재시도 →
 * 60초 뒤 엉뚱한 이름(buffer_overflow)으로 죽고, stop마저 undefined 오프셋을 실어
 * 봉인이 안 된다. 재동기화할 곳이 없는 409는 종단이므로 그렇게 알린다.
 */
function toPostResult(
  status: number,
  data: LiveBoundaryResponse | undefined,
): PostResult {
  if (typeof data?.expected_offset !== "number") {
    throw new LiveUploadRejected(
      "live chunk rejected without an expected_offset",
    );
  }
  const seal = SERVER_SEALS.find((c) => c === data.code);
  return {
    status: status === 200 ? 200 : 409,
    expected: data.expected_offset,
    ...(seal ? { code: seal } : {}),
  };
}

/**
 * 라이브 청크 업로드 (POST /meetings/:id/live/audio). 200과 409 둘 다 정상 흐름이다 —
 * 409의 expected_offset이 잃어버린 ACK 뒤 재동기화의 근거라, apiClient의 기본
 * 인터셉터(2xx 외 전부를 ApiError로 reject하며 몸통을 버림)를 이 요청만 우회해야
 * 그 값을 읽을 수 있다(다른 소비자는 전역 인터셉터를 그대로 탄다).
 */
export async function postLiveChunk(
  id: string,
  offset: number,
  body: Uint8Array,
  elapsedMs: number,
): Promise<PostResult> {
  const res = await apiClient.post<LiveBoundaryResponse>(
    `/meetings/${id}/live/audio`,
    body,
    {
      headers: {
        ...LIVE_BINARY_HEADERS,
        "X-Audio-Offset": String(offset),
        "X-Capture-Elapsed": String(elapsedMs),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      validateStatus: (s) => s === 200 || s === 409,
    },
  );
  return toPostResult(res.status, res.data);
}

/**
 * 라이브 종료 POST (POST /meetings/:id/live/stop). 청크와 **같은 PostResult**를 돌려준다 —
 * stop도 서버의 확정 경계로 판정되기 때문이다: ACK 유실로 서버 경계가 우리보다 앞서 있으면
 * 409 missing_chunk가 그 경계를 싣고 오고, 레코더는 거기서 빈 stop을 재시도한다 (설계 §7).
 * 옛 구현처럼 409를 그냥 던지면 그 경계가 사라져 세션이 영영 봉인되지 못한다.
 *
 * 서버가 돌려주는 outcome(stopping/discarded/finalized)은 onStopped로 곁가지 전달한다 —
 * discarded는 회의가 통째로 사라진 것이라 캐시 정리·네비게이션이 달라야 하는데,
 * LiveRecorder는 그 값을 보지 않는다.
 */
export async function postLiveStop(
  id: string,
  offset: number,
  final: number,
  body: Uint8Array,
  elapsedMs: number,
  failure: RecorderFailure | null,
  onStopped?: (res: LiveStopResponse) => void,
): Promise<PostResult> {
  const res = await apiClient.post<LiveStopResponse & LiveBoundaryResponse>(
    `/meetings/${id}/live/stop`,
    body,
    {
      headers: {
        ...LIVE_BINARY_HEADERS,
        "X-Audio-Offset": String(offset),
        "X-Final-Offset": String(final),
        "X-Capture-Elapsed": String(elapsedMs),
        // 캡처가 실패해서 끝났다는 사실이 탭 밖으로 나가는 유일한 통로다 (설계 §5.3·§7).
        ...(failure ? { "X-Capture-Error": failure } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      validateStatus: (s) => s === 200 || s === 409,
    },
  );
  if (res.status === 409) return toPostResult(409, res.data);
  onStopped?.(res.data);
  return { status: 200, expected: final };
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
