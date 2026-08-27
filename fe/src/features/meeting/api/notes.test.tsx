import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { useAutosaveNote, useMeetingNote } from "./notes";

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

  await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
  expect(put).toHaveBeenCalledWith("/meetings/mtg_1/note", {
    body_md: "날리면 안 됨",
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
