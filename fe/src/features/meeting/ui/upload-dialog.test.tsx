import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { UploadDialog } from "./upload-dialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const WIRE_MEETING = {
  id: "m1",
  title: null,
  original_filename: "a.m4a",
  audio_key: "meetings/m1/original.m4a",
  normalized_key: null,
  recorded_at: null,
  duration_ms: null,
  status: "uploaded",
  is_favorite: false,
  current_job_id: "job_1",
  processing_version: 0,
  error: null,
  created_at: new Date().toISOString(),
};

test("오버라이드 프리셋 선택 시 multipart에 processing JSON이 실린다", async () => {
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
    .mockResolvedValue({ data: WIRE_MEETING } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <UploadDialog open onOpenChange={() => {}} onUploaded={() => {}} />
    </QueryClientProvider>,
  );

  const fileInput = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  fireEvent.change(fileInput, {
    target: { files: [new File(["a"], "a.m4a", { type: "audio/mp4" })] },
  });

  fireEvent.click(
    screen.getByRole("button", { name: /이번 작업만 다른 설정/ }),
  );
  // Radix Select는 jsdom에서 pointer 이벤트를 못 받아 mousedown으로 열리지
  // 않는다. 트리거에 포커스 후 ArrowDown(키보드)으로 열고 옵션을 클릭한다.
  const presetTrigger = screen.getByLabelText("이번 작업 프리셋");
  presetTrigger.focus();
  fireEvent.keyDown(presetTrigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: /가볍게/ }));

  fireEvent.click(screen.getByRole("button", { name: "업로드" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  const form = post.mock.calls[0][1] as FormData;
  expect(form.get("processing")).toBe(JSON.stringify({ preset: "light" }));
});
