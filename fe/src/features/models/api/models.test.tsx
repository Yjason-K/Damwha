import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { apiClient } from "@/shared/api/client";
import { useModels } from "./models";
import type { ModelsView } from "./types";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const VIEW: ModelsView = { scannedAt: "t", totalBytes: 0, pending: false, models: [] };

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
