import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { apiClient } from "@/shared/api/client";
import type { ModelRow, ModelsView } from "../api/types";
import { ModelsCard } from "./models-card";

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
    deletable: true,
    ...over,
  };
}

const VIEW: ModelsView = {
  scannedAt: "2026-09-25T10:00:00.000000Z",
  totalBytes: 9_200_000_000,
  pending: false,
  models: [
    row({ inUseFor: ["stt"], deletable: false }),
    row({
      name: "large-v3",
      installed: "no",
      sizeBytes: null,
      approxBytes: 3_083_522_487,
    }),
    row({
      role: "summary",
      name: "mlx-community/Qwen3.5-4B-8bit",
      backend: null,
      inUseFor: ["summary", "lens"],
      sizeBytes: 5_163_524_489,
      deletable: false,
    }),
    row({
      role: "diarization",
      name: "pyannote/speaker-diarization-community-1",
      backend: null,
      inUseFor: ["fixed"],
      sizeBytes: 32_800_000,
      deletable: false,
    }),
    row({
      role: "speaker_embedding",
      name: "speechbrain/spkrec-ecapa-voxceleb",
      backend: null,
      inUseFor: ["fixed"],
      sizeBytes: 88_900_000,
      deletable: false,
    }),
    row({
      role: "search_embedding",
      name: "BAAI/bge-m3",
      backend: null,
      inUseFor: ["fixed"],
      sizeBytes: 2_293_250_249,
      deletable: false,
    }),
  ],
};

function renderCard(view: ModelsView) {
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: view } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ModelsCard />
    </QueryClientProvider>,
  );
}

test("요약 영역에 지금 설정에서 쓰는 모델과 합계를 보인다", async () => {
  renderCard(VIEW);
  const summary = await screen.findByRole("region", {
    name: "지금 설정에서 쓰는 모델",
  });
  expect(within(summary).getByText("large-v3-turbo · GPU")).toBeTruthy();
  expect(within(summary).getByText("요약·렌즈 추출")).toBeTruthy();
  expect(within(summary).getByText(/모두 받음/)).toBeTruthy();
  expect(screen.getByText("받은 모델 합계 9.2 GB")).toBeTruthy();
});

test("목록은 기본으로 사용 중·받은 것만, 펼치면 나머지", async () => {
  renderCard(VIEW);
  const list = await screen.findByRole("region", { name: "받아 둔 모델" });
  expect(within(list).queryByText("large-v3")).toBeNull();
  expect(within(list).getAllByText("사용 중").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "모든 모델 보기" }));
  expect(within(list).getByText("large-v3")).toBeTruthy();
  expect(within(list).getByText("안 받음 · 약 3.1 GB")).toBeTruthy();
  expect(screen.getByRole("button", { name: "접기" })).toBeTruthy();
});

test("고정 모델은 기본 모델 묶음에 사용자 이름으로 나온다", async () => {
  renderCard(VIEW);
  const list = await screen.findByRole("region", { name: "받아 둔 모델" });
  expect(within(list).getByText("기본 모델 · 항상 사용")).toBeTruthy();
  expect(within(list).getByText("화자 식별 모델")).toBeTruthy();
  expect(within(list).queryByText(/pyannote|speechbrain|bge/i)).toBeNull();
});

test("아직 스캔 전이면 안내 문구만", async () => {
  renderCard({
    scannedAt: null,
    totalBytes: null,
    pending: false,
    models: VIEW.models,
  });
  expect(
    await screen.findByText(
      "모델 상태를 아직 확인하지 못했어요. 작업 처리기가 준비되면 보여요.",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("region", { name: "받아 둔 모델" })).toBeNull();
});
