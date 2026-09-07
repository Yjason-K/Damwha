import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { LiveUploadRejected } from "../lib/live-recorder";
import type { WireLiveResponse } from "./types";
import {
  liveQueryKey,
  postLiveChunk,
  postLiveStop,
  useLiveUtterances,
  useStartLive,
  useStopLive,
} from "./live";
import { noteQueryKey } from "./notes";

afterEach(() => vi.restoreAllMocks());

function setup() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

const page = (items: WireLiveResponse["items"]): WireLiveResponse => ({
  status: "recording",
  stage: "capture",
  heartbeat_at: "2026-09-05T10:00:00.000Z",
  items,
});

const row = (seq: number, text: string) => ({
  id: `lut_${seq}`,
  seq,
  start_ms: seq * 1000,
  end_ms: seq * 1000 + 800,
  text,
  speaker_id: null,
  speaker_name: null,
  similarity: null,
});

test("첫 조회는 커서 없이, 다음 조회는 마지막 seq를 after로 보내고 append한다", async () => {
  const get = vi
    .spyOn(apiClient, "get")
    .mockResolvedValueOnce({
      data: page([row(0, "첫"), row(1, "둘")]),
    } as never)
    .mockResolvedValueOnce({ data: page([row(2, "셋")]) } as never);
  const { wrapper } = setup();
  const { result } = renderHook(() => useLiveUtterances("m1", "recording"), {
    wrapper,
  });
  await waitFor(() => expect(result.current.data?.items).toHaveLength(2));
  expect(get).toHaveBeenLastCalledWith("/meetings/m1/live", {
    params: undefined,
  });

  await act(async () => {
    await result.current.refetch();
  });
  await waitFor(() => expect(result.current.data?.items).toHaveLength(3));
  expect(get).toHaveBeenLastCalledWith("/meetings/m1/live", {
    params: { after: 1 },
  });
  expect(result.current.data?.items.map((i) => i.text)).toEqual([
    "첫",
    "둘",
    "셋",
  ]);
  expect(result.current.data?.items[2].t).toBe("00:02");
});

test("done 회의는 조회하지 않는다", async () => {
  const get = vi.spyOn(apiClient, "get");
  const { wrapper } = setup();
  renderHook(() => useLiveUtterances("m1", "done"), { wrapper });
  await new Promise((r) => setTimeout(r, 20));
  expect(get).not.toHaveBeenCalled();
});

test("녹음 시작은 JSON body를 보내고 목록을 무효화한다", async () => {
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({
    data: {
      id: "m7",
      title: "녹음",
      original_filename: null,
      audio_key: "meetings/m7/original.wav",
      normalized_key: null,
      recorded_at: "2026-09-05T10:00:00.000Z",
      duration_ms: null,
      status: "recording",
      is_favorite: false,
      current_job_id: "job_1",
      processing_version: 0,
      error: null,
      created_at: "2026-09-05T10:00:00.000Z",
    },
  } as never);
  const { qc, wrapper } = setup();
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const { result } = renderHook(() => useStartLive(), { wrapper });
  act(() => {
    result.current.mutate({
      title: "녹음",
      defer_summary: true,
      speakers: { min: 2 },
    });
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(post).toHaveBeenCalledWith("/meetings/live", {
    title: "녹음",
    defer_summary: true,
    speakers: { min: 2 },
  });
  expect(result.current.data?.id).toBe("m7");
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["meetings"] });
});

// useStopLive는 더 이상 스스로 POST를 만들지 않는다 — 종료는 브라우저 레코더의 꼬리를
// 실어 보내야 하므로(설계 §5.4), 실제 네트워크 호출은 호출자가 준 stop()이 한다(보통
// LiveRecorder.stop()). 이 훅은 그 결과(outcome)를 보고 캐시만 정리한다.
test("종료는 주어진 stop()을 실행하고, discarded면 그 회의에 딸린 캐시를 모두 지운다", async () => {
  const { qc, wrapper } = setup();
  const remove = vi.spyOn(qc, "removeQueries");
  const { result } = renderHook(() => useStopLive(), { wrapper });
  const stop = vi.fn().mockResolvedValue({
    meeting_id: "m7",
    job_id: "job_1",
    outcome: "discarded",
  });
  act(() => {
    result.current.mutate({ id: "m7", stop });
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(stop).toHaveBeenCalledTimes(1);
  // useDeleteMeeting과 같은 "회의가 더는 없다" 상황이므로 다섯 캐시 전부가
  // 지워져야 한다 — 하나라도 빠지면 낡은 화면이나 404 폴링 루프로 이어진다.
  expect(remove).toHaveBeenCalledWith({ queryKey: ["meeting", "m7"] });
  expect(remove).toHaveBeenCalledWith({ queryKey: ["meeting-status", "m7"] });
  expect(remove).toHaveBeenCalledWith({ queryKey: ["meeting-lenses", "m7"] });
  expect(remove).toHaveBeenCalledWith({ queryKey: noteQueryKey("m7") });
  expect(remove).toHaveBeenCalledWith({ queryKey: liveQueryKey("m7") });
  expect(remove).toHaveBeenCalledTimes(5);
});

test("종료가 stopping이면 상세·상태만 무효화하고 캐시를 지우지 않는다", async () => {
  const { qc, wrapper } = setup();
  const remove = vi.spyOn(qc, "removeQueries");
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const { result } = renderHook(() => useStopLive(), { wrapper });
  const stop = vi.fn().mockResolvedValue({
    meeting_id: "m7",
    job_id: "job_1",
    outcome: "stopping",
  });
  act(() => {
    result.current.mutate({ id: "m7", stop });
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(remove).not.toHaveBeenCalled();
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["meeting", "m7"] });
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: ["meeting-status", "m7"],
  });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["meetings"] });
});

// 인터셉터가 2xx 외 전부를 reject하며 몸통을 버리므로, 409의 expected_offset을 읽으려면
// 이 요청만 validateStatus를 넓혀야 한다 — 그 값이 재동기화의 근거다(설계 §3.3).
test("청크 업로드는 apiClient로 바이너리 POST하고 200/409 모두 정상 흐름으로 돌려준다", async () => {
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({
    status: 200,
    data: { expected_offset: 32768 },
  } as never);
  const body = new Uint8Array(32768);
  const result = await postLiveChunk("m1", 0, body, 1024);
  expect(result).toEqual({ status: 200, expected: 32768 });
  expect(post).toHaveBeenCalledWith(
    "/meetings/m1/live/audio",
    body,
    expect.objectContaining({
      headers: expect.objectContaining({
        "Content-Type": "application/octet-stream",
        "X-Audio-Offset": "0",
        "X-Capture-Elapsed": "1024",
      }),
      validateStatus: expect.any(Function),
    }),
  );
  const cfg = post.mock.calls[0][2] as {
    validateStatus: (s: number) => boolean;
  };
  expect(cfg.validateStatus(200)).toBe(true);
  expect(cfg.validateStatus(409)).toBe(true);
  expect(cfg.validateStatus(400)).toBe(false);
});

test("청크 업로드가 409면 status:409와 서버의 확정 경계를 돌려준다", async () => {
  vi.spyOn(apiClient, "post").mockResolvedValue({
    status: 409,
    data: { expected_offset: 32768 },
  } as never);
  const result = await postLiveChunk("m1", 65536, new Uint8Array(32768), 2048);
  expect(result).toEqual({ status: 409, expected: 32768 });
});

// 자동 봉인은 재동기화가 아니다 — 레코더가 일반 ACK와 갈라 다뤄야 하므로 code를 실어 보낸다.
test("서버가 스스로 봉인한 409는 code를 그대로 실어 보낸다", async () => {
  vi.spyOn(apiClient, "post").mockResolvedValue({
    status: 409,
    data: { expected_offset: 460800000, code: "duration_limit" },
  } as never);
  expect(
    await postLiveChunk("m1", 460783616, new Uint8Array(32768), 1),
  ).toEqual({ status: 409, expected: 460800000, code: "duration_limit" });
});

// 알 수 없는 code는 재동기화용 409의 부가 정보일 뿐이라 종료 사유로 승격하지 않는다.
test("모르는 code는 PostResult에 실리지 않는다", async () => {
  vi.spyOn(apiClient, "post").mockResolvedValue({
    status: 409,
    data: { expected_offset: 32768, code: "missing_chunk" },
  } as never);
  expect(await postLiveChunk("m1", 0, new Uint8Array(32768), 1)).toEqual({
    status: 409,
    expected: 32768,
  });
});

test("종료 POST는 오프셋 헤더와 꼬리 바디를 싣고, 성공하면 응답을 콜백으로 넘긴다", async () => {
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({
    status: 200,
    data: { meeting_id: "m1", job_id: "job_1", outcome: "stopping" },
  } as never);
  const onStopped = vi.fn();
  const tail = new Uint8Array(32);
  await postLiveStop("m1", 32768, 32800, tail, 33000, null, onStopped);
  expect(post).toHaveBeenCalledWith(
    "/meetings/m1/live/stop",
    tail,
    expect.objectContaining({
      headers: expect.objectContaining({
        "Content-Type": "application/octet-stream",
        "X-Audio-Offset": "32768",
        "X-Final-Offset": "32800",
        "X-Capture-Elapsed": "33000",
      }),
    }),
  );
  expect(onStopped).toHaveBeenCalledWith({
    meeting_id: "m1",
    job_id: "job_1",
    outcome: "stopping",
  });
  // 정상 종료엔 실패 헤더가 붙지 않는다.
  const cfg = post.mock.calls[0][2] as { headers: Record<string, string> };
  expect(cfg.headers).not.toHaveProperty("X-Capture-Error");
});

// 이 헤더가 캡처 실패를 탭 밖으로 내보내는 유일한 통로다 (설계 §5.3·§7).
test("종료 POST는 레코더 실패 사유를 X-Capture-Error로 싣는다", async () => {
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({
    status: 200,
    data: { meeting_id: "m1", job_id: "job_1", outcome: "stopping" },
  } as never);
  await postLiveStop("m1", 0, 0, new Uint8Array(0), 5000, "device_ended");
  expect(post).toHaveBeenCalledWith(
    "/meetings/m1/live/stop",
    expect.anything(),
    expect.objectContaining({
      headers: expect.objectContaining({ "X-Capture-Error": "device_ended" }),
    }),
  );
});

// 재동기화할 오프셋이 없는 409를 그대로 통과시키면 offset이 undefined로 오염돼
// 이후 모든 요청이 400을 받고 봉인 자체가 불가능해진다.
test("expected_offset 없는 409는 LiveUploadRejected로 끊는다", async () => {
  vi.spyOn(apiClient, "post").mockResolvedValue({
    status: 409,
    data: { code: "io_error", message: "disk" },
  } as never);
  await expect(
    postLiveChunk("m1", 32768, new Uint8Array(32768), 1024),
  ).rejects.toBeInstanceOf(LiveUploadRejected);
});

// 옛 구현은 이 409를 그냥 던졌다. 그러면 서버의 확정 경계가 사라져 레코더가 그 자리에서
// 빈 stop을 재시도할 수 없고, 세션이 영영 봉인되지 못한다 (설계 §7).
test("종료 POST가 409면 서버의 확정 경계를 돌려주고 콜백을 부르지 않는다", async () => {
  vi.spyOn(apiClient, "post").mockResolvedValue({
    status: 409,
    data: { expected_offset: 999, code: "missing_chunk" },
  } as never);
  const onStopped = vi.fn();
  expect(
    await postLiveStop("m1", 0, 32, new Uint8Array(32), 100, null, onStopped),
  ).toEqual({ status: 409, expected: 999 });
  expect(onStopped).not.toHaveBeenCalled();
});

test("종료 POST가 성공하면 final을 확정 경계로 돌려준다", async () => {
  vi.spyOn(apiClient, "post").mockResolvedValue({
    status: 200,
    data: { meeting_id: "m1", job_id: "job_1", outcome: "finalized" },
  } as never);
  expect(
    await postLiveStop("m1", 32768, 32800, new Uint8Array(32), 100, null),
  ).toEqual({ status: 200, expected: 32800 });
});
