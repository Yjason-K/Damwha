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
import { ReprocessDialog } from "./reprocess-dialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(post = vi.fn()) {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: {
      preset: "standard",
      preset_revision: null,
      language: "ko",
      whisper_model: "large-v3-turbo",
      devices: { diarization: "gpu", stt: "gpu" },
    },
  } as never);
  vi.spyOn(apiClient, "post").mockImplementation(post as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ReprocessDialog
        open
        onOpenChange={() => {}}
        meeting={{ id: "m1", title: "주간 회의" }}
      />
    </QueryClientProvider>,
  );
  return post;
}

test("확인 시 POST /meetings/:id/reprocess 호출 (오버라이드 없으면 빈 body)", async () => {
  const post = setup(
    vi.fn().mockResolvedValue({
      data: { meeting_id: "m1", processing_version: 1, job_id: "job_2" },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "재처리 시작" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  expect(post).toHaveBeenCalledWith("/meetings/m1/reprocess", {});
});

test("오버라이드 선택 시 body에 processing이 실린다", async () => {
  const post = setup(
    vi.fn().mockResolvedValue({
      data: { meeting_id: "m1", processing_version: 1, job_id: "job_2" },
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: /이번 작업만 다른 설정/ }),
  );
  // Radix Select는 jsdom에서 pointer 이벤트를 못 받아 mousedown으로 열리지
  // 않는다. 트리거에 포커스 후 ArrowDown(키보드)으로 열고 옵션을 클릭한다.
  const trigger = screen.getByLabelText("이번 작업 프리셋");
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: /고품질/ }));
  fireEvent.click(screen.getByRole("button", { name: "재처리 시작" }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith("/meetings/m1/reprocess", {
      processing: { preset: "quality" },
    }),
  );
});
