import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import type { WireLiveResponse } from "./types";
import {
  liveQueryKey,
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

test("종료가 discarded면 그 회의에 딸린 캐시를 모두 지운다", async () => {
  vi.spyOn(apiClient, "post").mockResolvedValue({
    data: { meeting_id: "m7", job_id: "job_1", outcome: "discarded" },
  } as never);
  const { qc, wrapper } = setup();
  const remove = vi.spyOn(qc, "removeQueries");
  const { result } = renderHook(() => useStopLive(), { wrapper });
  act(() => {
    result.current.mutate("m7");
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  // useDeleteMeeting과 같은 "회의가 더는 없다" 상황이므로 다섯 캐시 전부가
  // 지워져야 한다 — 하나라도 빠지면 낡은 화면이나 404 폴링 루프로 이어진다.
  expect(remove).toHaveBeenCalledWith({ queryKey: ["meeting", "m7"] });
  expect(remove).toHaveBeenCalledWith({ queryKey: ["meeting-status", "m7"] });
  expect(remove).toHaveBeenCalledWith({ queryKey: ["meeting-lenses", "m7"] });
  expect(remove).toHaveBeenCalledWith({ queryKey: noteQueryKey("m7") });
  expect(remove).toHaveBeenCalledWith({ queryKey: liveQueryKey("m7") });
  expect(remove).toHaveBeenCalledTimes(5);
});
