import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";

import { ApiError, apiClient } from "@/shared/api/client";
import { LiveStartDialog, defaultLiveTitle } from "./live-start-dialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const WIRE = {
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
};

function renderDialog(onStarted = vi.fn()) {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: {
      preset: "standard",
      preset_revision: null,
      language: "ko",
      whisper_model: "large-v3-turbo",
      devices: { diarization: "gpu", stt: "gpu" },
    },
  } as never);
  const post = vi
    .spyOn(apiClient, "post")
    .mockResolvedValue({ data: WIRE } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <LiveStartDialog open onOpenChange={() => {}} onStarted={onStarted} />
    </QueryClientProvider>,
  );
  return { post, onStarted };
}

test("기본 제목은 '녹음 YYYY-MM-DD HH:mm'이다", () => {
  expect(defaultLiveTitle(new Date(2026, 8, 5, 14, 7))).toBe(
    "녹음 2026-09-05 14:07",
  );
});

test("제목·미루기 선택이 JSON body로 실리고 성공하면 onStarted를 부른다", async () => {
  const { post, onStarted } = renderDialog();
  const title = screen.getByLabelText("제목 (선택)") as HTMLInputElement;
  expect(title.value).toMatch(/^녹음 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  fireEvent.change(title, { target: { value: "주간 회의" } });
  fireEvent.click(screen.getByRole("radio", { name: "요약 나중에 실행" }));
  fireEvent.click(screen.getByRole("button", { name: "녹음 시작" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith("m7"));
  expect(post).toHaveBeenCalledWith("/meetings/live", {
    title: "주간 회의",
    defer_summary: true,
  });
});

test("409면 이미 녹음 중이라는 토스트를 띄우고 닫지 않는다", async () => {
  const { onStarted } = renderDialog();
  vi.spyOn(apiClient, "post").mockRejectedValue(
    new ApiError(409, "a recording is already in progress"),
  );
  fireEvent.click(screen.getByRole("button", { name: "녹음 시작" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "녹음 시작" }),
    ).not.toBeDisabled(),
  );
  expect(onStarted).not.toHaveBeenCalled();
});
