import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import type { MeetingStatus } from "@/features/meeting/model/types";
import { useMeetingLenses } from "./lenses";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// rerender가 캐시를 갈아치우지 않도록 테스트마다 클라이언트를 하나만 만든다.
function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const reply = (extraction_status: string | null) =>
  ({ data: { items: [], extraction_status } }) as never;

test("요약을 미뤄도 처리가 끝나면 렌즈를 다시 읽고 queued → done까지 따라간다", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const get = vi
    .spyOn(apiClient, "get")
    .mockResolvedValueOnce(reply(null)) // 처리 중 첫 조회 — run 행이 아직 없다
    .mockResolvedValueOnce(reply("queued")) // persist가 run을 큐에 넣었다
    .mockResolvedValue(reply("done"));

  const { result, rerender } = renderHook(
    ({ status }: { status: MeetingStatus }) => useMeetingLenses("m1", status),
    { wrapper: makeWrapper(), initialProps: { status: "processing" } },
  );
  await waitFor(() => expect(result.current.data?.extractionStatus).toBe(null));

  // null이면 폴링하지 않는다 — 처리 중에는 조용하다.
  await vi.advanceTimersByTimeAsync(10_000);
  expect(get).toHaveBeenCalledTimes(1);

  // 요약 상태 변화 없이 회의만 done이 된다.
  rerender({ status: "done" });
  await waitFor(() =>
    expect(result.current.data?.extractionStatus).toBe("queued"),
  );

  await vi.advanceTimersByTimeAsync(5100);
  await waitFor(() =>
    expect(result.current.data?.extractionStatus).toBe("done"),
  );
  expect(get).toHaveBeenCalledTimes(3);
});

test("처음부터 done인 회의는 한 번만 읽는다", async () => {
  const get = vi.spyOn(apiClient, "get").mockResolvedValue(reply(null));
  const { result } = renderHook(() => useMeetingLenses("m1", "done"), {
    wrapper: makeWrapper(),
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(get).toHaveBeenCalledTimes(1);
});
