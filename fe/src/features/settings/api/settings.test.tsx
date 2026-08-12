import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import {
  useCapabilities,
  useProcessingSettings,
  useUpdateProcessingSettings,
} from "./settings";
import type { ProcessingConfig } from "./types";

afterEach(() => vi.restoreAllMocks());

const CONFIG: ProcessingConfig = {
  preset: "standard",
  preset_revision: "2026-08-12.1",
  language: "ko",
  whisper_model: "large-v3-turbo",
  devices: { diarization: "gpu", stt: "gpu" },
  summary_model: "qwen3.5:8b-mlx",
};

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

test("useProcessingSettings가 GET /settings/processing을 조회한다", async () => {
  const get = vi
    .spyOn(apiClient, "get")
    .mockResolvedValue({ data: CONFIG } as never);
  const { result } = renderHook(() => useProcessingSettings(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(get).toHaveBeenCalledWith("/settings/processing");
  expect(result.current.data?.whisper_model).toBe("large-v3-turbo");
});

test("useUpdateProcessingSettings가 PUT 후 설정 쿼리를 무효화한다", async () => {
  vi.spyOn(apiClient, "put").mockResolvedValue({ data: CONFIG } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const { result } = renderHook(() => useUpdateProcessingSettings(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  });
  await result.current.mutateAsync({ preset: "light", language: "ko" });
  expect(apiClient.put).toHaveBeenCalledWith("/settings/processing", {
    preset: "light",
    language: "ko",
  });
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: ["processing-settings"],
  });
});

test("useCapabilities가 GET /system/capabilities를 조회한다", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: {
      platform: "darwin",
      arch: "arm64",
      chip: "Apple M2 Pro",
      memory_gb: 32,
      gpu_eligible: true,
      recommended_preset: "standard",
    },
  } as never);
  const { result } = renderHook(() => useCapabilities(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.gpu_eligible).toBe(true);
});
