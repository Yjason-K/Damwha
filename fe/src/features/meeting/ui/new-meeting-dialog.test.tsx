import { useState } from "react";
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
import { NewMeetingDialog } from "./new-meeting-dialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
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

/** 파일 하나 고른 상태의 다이얼로그를 띄우고 post 스파이를 돌려준다. */
function renderWithFile() {
  const post = vi
    .spyOn(apiClient, "post")
    .mockResolvedValue({ data: WIRE_MEETING } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <NewMeetingDialog open onOpenChange={() => {}} onCreated={() => {}} />
    </QueryClientProvider>,
  );
  const fileInput = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  fireEvent.change(fileInput, {
    target: { files: [new File(["a"], "a.m4a", { type: "audio/mp4" })] },
  });
  return post;
}

test("회의 기록 방식은 모달용 choice 탭으로 표시한다", () => {
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <NewMeetingDialog open onOpenChange={() => {}} onCreated={() => {}} />
    </QueryClientProvider>,
  );

  expect(
    screen.getByRole("tablist", { name: "회의 기록 방식" }),
  ).toHaveAttribute("data-variant", "choice");
});

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
      <NewMeetingDialog open onOpenChange={() => {}} onCreated={() => {}} />
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

  fireEvent.click(screen.getByRole("button", { name: "업로드 시작" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  const form = post.mock.calls[0][1] as FormData;
  expect(form.get("processing")).toBe(JSON.stringify({ preset: "light" }));
});

test("화자 수를 입력하면 multipart에 speakers JSON이 실린다", async () => {
  const post = renderWithFile();
  fireEvent.change(screen.getByLabelText("최소 화자 수"), {
    target: { value: "2" },
  });
  fireEvent.change(screen.getByLabelText("최대 화자 수"), {
    target: { value: "4" },
  });
  fireEvent.click(screen.getByRole("button", { name: "업로드 시작" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  const form = post.mock.calls[0][1] as FormData;
  expect(form.get("speakers")).toBe(JSON.stringify({ min: 2, max: 4 }));
});

test("화자 수 범위가 뒤집히면 업로드 버튼이 막힌다", () => {
  renderWithFile();
  fireEvent.change(screen.getByLabelText("최소 화자 수"), {
    target: { value: "5" },
  });
  fireEvent.change(screen.getByLabelText("최대 화자 수"), {
    target: { value: "2" },
  });
  expect(
    (screen.getByRole("button", { name: "업로드 시작" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("후속 처리는 기본이 자동 실행 — defer 필드가 실리지 않는다", async () => {
  const post = renderWithFile();
  fireEvent.click(screen.getByRole("button", { name: "업로드 시작" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  const form = post.mock.calls[0][1] as FormData;
  expect(form.get("defer_lens")).toBeNull();
  expect(form.get("defer_summary")).toBeNull();
});

test("나중에 실행을 고르면 해당 후속만 defer로 실린다", async () => {
  const post = renderWithFile();
  fireEvent.click(screen.getByRole("radio", { name: "요약 나중에 실행" }));
  fireEvent.click(screen.getByRole("button", { name: "업로드 시작" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  const form = post.mock.calls[0][1] as FormData;
  expect(form.get("defer_summary")).toBe("true");
  expect(form.get("defer_lens")).toBeNull();
});

test("녹음 일시를 비웠을 때 어떻게 되는지 알려준다", () => {
  renderWithFile();
  expect(
    screen.getByText("비우면 업로드 시각으로 기록됩니다."),
  ).toBeInTheDocument();
});

function selectSource(name: string) {
  fireEvent.mouseDown(screen.getByRole("tab", { name }), {
    button: 0,
    ctrlKey: false,
  });
}

test("탭을 오가도 파일과 공통 설정을 보존하고 선택만으로 요청하지 않는다", async () => {
  const post = renderWithFile();
  fireEvent.change(screen.getByLabelText("제목 (선택)"), {
    target: { value: "기획 회의" },
  });
  fireEvent.change(screen.getByLabelText("최소 화자 수"), {
    target: { value: "2" },
  });
  fireEvent.click(screen.getByRole("radio", { name: "요약 나중에 실행" }));
  selectSource("실시간 녹음");
  expect(screen.getByLabelText("제목 (선택)")).toHaveValue("기획 회의");
  expect(screen.getByLabelText("최소 화자 수")).toHaveValue(2);
  expect(screen.getByRole("radio", { name: "요약 나중에 실행" })).toBeChecked();
  expect(screen.queryByText("녹음 일시 (선택)")).not.toBeInTheDocument();
  expect(post).not.toHaveBeenCalled();
  selectSource("오디오 파일");
  expect(screen.getByText(/a.m4a/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "업로드 시작" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  const form = post.mock.calls[0][1] as FormData;
  expect(form.get("title")).toBe("기획 회의");
  expect(form.get("audio")).toBeInstanceOf(File);
  expect(form.get("defer_summary")).toBe("true");
});

test("새로 마운트해도 마지막 탭을 기억한다", () => {
  renderWithFile();
  selectSource("실시간 녹음");
  cleanup();
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <NewMeetingDialog open onOpenChange={() => {}} onCreated={() => {}} />
    </QueryClientProvider>,
  );
  expect(screen.getByRole("tab", { name: "실시간 녹음" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByLabelText("제목 (선택)")).toHaveValue("");
});

test("요청 중에는 탭 전환과 닫기를 막아 중복 실행을 방지한다", async () => {
  const post = renderWithFile();
  post.mockImplementation(() => new Promise(() => {}));
  fireEvent.click(screen.getByRole("button", { name: "업로드 시작" }));
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "실시간 녹음" })).toBeDisabled(),
  );
  expect(screen.getByRole("button", { name: "취소" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "업로드 시작" })).toBeDisabled();
});

test("같은 모달을 닫고 다시 열면 입력은 비우고 선택한 탭은 유지한다", () => {
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button onClick={() => setOpen(true)}>다시 열기</button>
        <NewMeetingDialog
          open={open}
          onOpenChange={setOpen}
          onCreated={() => {}}
        />
      </>
    );
  }
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <Harness />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText("제목 (선택)"), {
    target: { value: "초안" },
  });
  fireEvent.change(document.querySelector('input[type="file"]')!, {
    target: { files: [new File(["a"], "a.m4a", { type: "audio/mp4" })] },
  });
  selectSource("실시간 녹음");
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "다시 열기" }));
  expect(screen.getByRole("tab", { name: "실시간 녹음" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByLabelText("제목 (선택)")).toHaveValue("");
  selectSource("오디오 파일");
  expect(screen.getByText("선택된 파일이 없어요")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "업로드 시작" })).toBeDisabled();
});
