import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { noteQueryKey, useAutosaveNote, useMeetingNote } from "./notes";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

test("useMeetingNote가 GET /meetings/:id/note를 조회한다", async () => {
  const get = vi.spyOn(apiClient, "get").mockResolvedValue({
    data: {
      note: { body_md: "## 메모", updated_at: "2026-08-27T00:00:00.000Z" },
    },
  } as never);
  const { result } = renderHook(() => useMeetingNote("mtg_1"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(get).toHaveBeenCalledWith("/meetings/mtg_1/note");
  expect(result.current.data?.body_md).toBe("## 메모");
});

test("메모가 없으면 data는 null이다", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { note: null },
  } as never);
  const { result } = renderHook(() => useMeetingNote("mtg_1"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toBeNull();
});

test("연속 입력은 800ms 뒤 한 번만 저장한다", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { note: null },
  } as never);
  const put = vi.spyOn(apiClient, "put").mockResolvedValue({
    data: { note: { body_md: "가나", updated_at: "2026-08-27T00:00:00.000Z" } },
  } as never);
  vi.useFakeTimers({ shouldAdvanceTime: true });

  const { result } = renderHook(() => useAutosaveNote("mtg_1"), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  act(() => result.current.change("가"));
  act(() => result.current.change("가나"));
  expect(put).not.toHaveBeenCalled();

  await act(async () => {
    vi.advanceTimersByTime(800);
  });
  await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
  expect(put).toHaveBeenCalledWith("/meetings/mtg_1/note", { body_md: "가나" });
});

test("언마운트 시 대기 중인 입력을 flush한다", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { note: null },
  } as never);
  const put = vi.spyOn(apiClient, "put").mockResolvedValue({
    data: {
      note: { body_md: "날리면 안 됨", updated_at: "2026-08-27T00:00:00.000Z" },
    },
  } as never);
  vi.useFakeTimers({ shouldAdvanceTime: true });

  const { result, unmount } = renderHook(() => useAutosaveNote("mtg_1"), {
    wrapper,
  });
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  act(() => result.current.change("날리면 안 됨"));
  unmount();

  // waitFor를 그냥 쓰면 shouldAdvanceTime이 실시간과 함께 fake clock을
  // 흘려보내다가 800ms debounce가 "저절로" 끝나 버려, 언마운트 flush가
  // 삭제돼도 테스트가 우연히 통과할 수 있다(실제로 리뷰어가 확인함).
  // advanceTimersByTimeAsync(0)으로 실제 시간을 흘리지 않고 마이크로태스크
  // 큐만 비워서, 언마운트가 직접 flush를 부른 경우에만 통과하게 만든다.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(put).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenCalledWith("/meetings/mtg_1/note", {
    body_md: "날리면 안 됨",
  });
});

test("회의가 바뀌면 이전 회의의 대기 중인 입력을 flush한다", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { note: null },
  } as never);
  const put = vi.spyOn(apiClient, "put").mockResolvedValue({
    data: {
      note: {
        body_md: "이전 회의 메모",
        updated_at: "2026-08-27T00:00:00.000Z",
      },
    },
  } as never);
  vi.useFakeTimers({ shouldAdvanceTime: true });

  const { result, rerender } = renderHook(
    ({ meetingId }: { meetingId: string }) => useAutosaveNote(meetingId),
    { wrapper, initialProps: { meetingId: "mtg_1" } },
  );
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  act(() => result.current.change("이전 회의 메모"));
  rerender({ meetingId: "mtg_2" });

  // 위 언마운트 테스트와 같은 이유로 실시간 800ms가 흐르게 두지 않는다.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(put).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenCalledWith("/meetings/mtg_1/note", {
    body_md: "이전 회의 메모",
  });
});

test("저장이 실패하면 state가 error이고 retry가 다시 보낸다", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { note: null },
  } as never);
  const put = vi.spyOn(apiClient, "put").mockRejectedValue(new Error("boom"));
  vi.useFakeTimers({ shouldAdvanceTime: true });

  const { result } = renderHook(() => useAutosaveNote("mtg_1"), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  act(() => result.current.change("실패할 메모"));
  await act(async () => {
    vi.advanceTimersByTime(800);
  });
  await waitFor(() => expect(result.current.state).toBe("error"));

  act(() => result.current.retry());
  await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
});

test("저장이 실패하면 캐시를 실패 전 값으로 되돌린다", async () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function localWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: {
      note: { body_md: "원래 메모", updated_at: "2026-08-27T00:00:00.000Z" },
    },
  } as never);
  vi.spyOn(apiClient, "put").mockRejectedValue(new Error("boom"));
  vi.useFakeTimers({ shouldAdvanceTime: true });

  const { result } = renderHook(() => useAutosaveNote("mtg_1"), {
    wrapper: localWrapper,
  });
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  act(() => result.current.change("실패할 새 메모"));
  await act(async () => {
    vi.advanceTimersByTime(800);
  });
  await waitFor(() => expect(result.current.state).toBe("error"));

  expect(qc.getQueryData(noteQueryKey("mtg_1"))).toEqual({
    body_md: "원래 메모",
    updated_at: "2026-08-27T00:00:00.000Z",
  });
});
