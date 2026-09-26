import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { apiClient } from "@/shared/api/client";
import type { ModelRow, ModelsView } from "../api/types";
import { ModelsInUse } from "./models-in-use";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function row(over: Partial<ModelRow>): ModelRow {
  return {
    role: "stt",
    name: "large-v3-turbo",
    backend: "mlx",
    repoId: "r",
    inUseFor: [],
    installed: "yes",
    sizeBytes: 1_613_979_758,
    approxBytes: null,
    downloading: null,
    deletable: false,
    job: null,
    ...over,
  };
}

const VIEW: ModelsView = {
  scannedAt: "t",
  totalBytes: 1,
  pending: false,
  freeBytes: null,
  models: [
    row({ inUseFor: ["stt"] }),
    row({
      role: "summary",
      name: "mlx-community/Qwen3.5-4B-8bit",
      backend: null,
      inUseFor: ["summary", "lens"],
      sizeBytes: 5_163_524_489,
    }),
    row({
      role: "summary",
      name: "mlx-community/Qwen3.5-27B-8bit",
      backend: null,
      installed: "no",
      sizeBytes: null,
      approxBytes: 29_528_168_817,
    }),
    row({
      role: "diarization",
      name: "pyannote/speaker-diarization-community-1",
      backend: null,
      inUseFor: ["fixed"],
      sizeBytes: 32_800_000,
    }),
  ],
};

function renderInUse(pick: Parameters<typeof ModelsInUse>[0]["pick"]) {
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: VIEW } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ModelsInUse pick={pick} />
    </QueryClientProvider>,
  );
}

test("고른 값으로 쓰는 모델과 받음 상태를 보인다 — 렌즈 추출은 서버가 정한 값 그대로", async () => {
  renderInUse({
    whisper_model: "large-v3-turbo",
    devices: { stt: "gpu" },
    summary_model: "mlx-community/Qwen3.5-27B-8bit",
  });
  const box = await screen.findByRole("region", {
    name: "이 설정으로 쓰는 모델",
  });
  expect(within(box).getByText("large-v3-turbo · GPU")).toBeTruthy();
  expect(within(box).getByText("qwen3.5 27B")).toBeTruthy();
  expect(within(box).getByText("렌즈 추출")).toBeTruthy();
  expect(within(box).getByText("32.8 MB")).toBeTruthy();
});

test("안 받은 고른 모델에 미리 받기 — 목록에 없던 CPU 전사도 논리 키로 받는다", async () => {
  const post = vi
    .spyOn(apiClient, "post")
    .mockResolvedValue({ data: {} } as never);
  renderInUse({
    whisper_model: "small",
    devices: { stt: "cpu" },
    summary_model: "mlx-community/Qwen3.5-4B-8bit",
  });
  const box = await screen.findByRole("region", {
    name: "이 설정으로 쓰는 모델",
  });
  fireEvent.click(
    within(box).getByRole("button", { name: /small.*미리 받기/ }),
  );
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith("/models/download", {
      role: "stt",
      name: "small",
      backend: "faster",
    }),
  );
});
