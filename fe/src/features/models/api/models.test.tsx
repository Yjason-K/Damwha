import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { apiClient } from "@/shared/api/client";
import { useCancelModelJob, useDeleteModel, useDownloadModel, useModels } from "./models";
import type { ModelsView } from "./types";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const VIEW: ModelsView = { scannedAt: "t", totalBytes: 0, pending: false, models: [], freeBytes: null };

test("GET /models를 조회한다", async () => {
  const get = vi.spyOn(apiClient, "get").mockResolvedValue({ data: VIEW } as never);
  const { result } = renderHook(() => useModels(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(get).toHaveBeenCalledWith("/models");
});

test("pending이면 3초마다 다시 읽고, 아니면 멈춘다", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const get = vi
    .spyOn(apiClient, "get")
    .mockResolvedValueOnce({ data: { ...VIEW, pending: true } } as never)
    .mockResolvedValue({ data: VIEW } as never);
  const { result } = renderHook(() => useModels(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  await vi.advanceTimersByTimeAsync(3100);
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(get).toHaveBeenCalledTimes(2);
});

test("받기·삭제·취소 뮤테이션은 성공 시 models를 무효화한다", async () => {
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: { job: { id: "job_1" } } } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const w = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result: d } = renderHook(() => useDownloadModel(), { wrapper: w });
  await d.current.mutateAsync({ role: "stt", name: "small", backend: "mlx" });
  expect(post).toHaveBeenCalledWith("/models/download", { role: "stt", name: "small", backend: "mlx" });
  const { result: x } = renderHook(() => useDeleteModel(), { wrapper: w });
  await x.current.mutateAsync({ role: "summary", name: "m", backend: null });
  expect(post).toHaveBeenCalledWith("/models/delete", { role: "summary", name: "m" });
  const { result: c } = renderHook(() => useCancelModelJob(), { wrapper: w });
  await c.current.mutateAsync("job_1");
  expect(post).toHaveBeenCalledWith("/models/cancel", { jobId: "job_1" });
  expect(invalidate).toHaveBeenCalledTimes(3);
});
