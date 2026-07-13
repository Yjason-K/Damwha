import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { SettingsPage } from "./settings";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("설정 페이지가 감지 스펙 카드와 처리 설정 폼을 렌더한다", async () => {
  vi.spyOn(apiClient, "get").mockImplementation(async (url) => {
    if (url === "/system/capabilities")
      return {
        data: {
          platform: "darwin",
          arch: "arm64",
          chip: "Apple M2 Pro",
          memory_gb: 32,
          gpu_eligible: true,
          recommended_preset: "standard",
        },
      } as never;
    if (url === "/settings/processing")
      return {
        data: {
          preset: "standard",
          preset_revision: "2026-07-13.1",
          language: "ko",
          whisper_model: "large-v3-turbo",
          devices: { diarization: "gpu", stt: "gpu" },
        },
      } as never;
    throw new Error(`unexpected GET ${url}`);
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Apple M2 Pro")).toBeTruthy();
  expect(screen.getByText(/메모리 32\s*GB/)).toBeTruthy();
  expect(await screen.findByRole("radio", { name: /표준/ })).toBeTruthy();
});
