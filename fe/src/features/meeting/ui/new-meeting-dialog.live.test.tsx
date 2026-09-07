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
import { clearLiveCapture, getLiveRecorder } from "../lib/live-session";
import { NewMeetingDialog } from "./new-meeting-dialog";
import { defaultLiveTitle } from "../lib/default-live-title";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "mediaDevices");
  Reflect.deleteProperty(navigator, "permissions");
  clearLiveCapture("m7");
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

/**
 * jsdom엔 navigator.mediaDevices/permissions가 아예 없다 — lib/live-recorder.test.ts의
 * stubMediaDevices와 같은 패턴이되, 다이얼로그의 장치 선택 UI를 위해 deviceId/label을
 * 더한다. getUserMedia는 실제로 마이크를 여는 시나리오(성공 시 recorder.start() 호출)를
 * 검증할 수 있도록 가짜 스트림을 낸다 — 그 뒤 AudioContext는 jsdom에 없어 start()
 * 자체는 reject하지만, 다이얼로그는 이를 캐치해 토스트만 띄우므로 이 파일의 단언에는
 * 영향이 없다.
 */
function stubMediaDevices(
  options: {
    permission?: "granted" | "denied";
    devices?: Array<{ deviceId: string; label: string }>;
  } = {},
) {
  const devices = (
    options.devices ?? [{ deviceId: "default", label: "내장 마이크" }]
  ).map((d) => ({ kind: "audioinput" as const, ...d }));
  const stream = {
    getTracks: () => [{ stop: vi.fn() }],
    getAudioTracks: () => [{ addEventListener: vi.fn() }],
  };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue(stream),
      enumerateDevices: vi.fn().mockResolvedValue(devices),
    },
  });
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: {
      query: vi
        .fn()
        .mockResolvedValue({ state: options.permission ?? "granted" }),
    },
  });
}

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
      <NewMeetingDialog open onOpenChange={() => {}} onCreated={onStarted} />
    </QueryClientProvider>,
  );
  fireEvent.mouseDown(screen.getByRole("tab", { name: "실시간 녹음" }), {
    button: 0,
    ctrlKey: false,
  });
  return { post, onStarted };
}

test("기본 제목은 '녹음 YYYY-MM-DD HH:mm'이다", () => {
  expect(defaultLiveTitle(new Date(2026, 8, 5, 14, 7))).toBe(
    "녹음 2026-09-05 14:07",
  );
});

// 설계 §5.2 — 원 설계에서 회의 중간에 audio_device_failed로 터지던 실패를 전부 시작
// 전으로 옮긴다. insecure context에서는 navigator.mediaDevices 자체가 없다 —
// jsdom의 기본 상태가 정확히 그 상태라 아무것도 stub하지 않는다.
test("insecure context에서는 녹음을 막고 회의를 만들지 않는다", async () => {
  const { post } = renderDialog();
  fireEvent.click(screen.getByRole("button", { name: "녹음 시작" }));
  expect(await screen.findByText(/HTTPS/)).toBeInTheDocument();
  expect(post).not.toHaveBeenCalledWith("/meetings/live", expect.anything());
});

test("마이크 권한이 거부됐으면 녹음을 막는다", async () => {
  stubMediaDevices({ permission: "denied" });
  const { post } = renderDialog();
  fireEvent.click(screen.getByRole("button", { name: "녹음 시작" }));
  expect(await screen.findByText(/마이크 권한/)).toBeInTheDocument();
  expect(post).not.toHaveBeenCalledWith("/meetings/live", expect.anything());
});

test("입력 장치가 없으면 녹음을 막는다", async () => {
  stubMediaDevices({ devices: [] });
  renderDialog();
  fireEvent.click(screen.getByRole("button", { name: "녹음 시작" }));
  expect(
    await screen.findByText("입력 장치를 찾지 못했어요."),
  ).toBeInTheDocument();
});

test("게이트를 통과하면 enumerateDevices가 돌려준 입력 장치를 보여준다", async () => {
  stubMediaDevices({
    devices: [{ deviceId: "a", label: "내장 마이크" }],
  });
  renderDialog();
  fireEvent.click(screen.getByRole("button", { name: "녹음 시작" }));
  expect(await screen.findByText("내장 마이크")).toBeInTheDocument();
});

test("제목·미루기 선택이 JSON body로 실리고 성공하면 onStarted를 부른다", async () => {
  stubMediaDevices();
  const { post, onStarted } = renderDialog();
  const title = screen.getByLabelText("제목 (선택)") as HTMLInputElement;
  expect(title.value).toBe("");
  fireEvent.change(title, { target: { value: "주간 회의" } });
  fireEvent.click(screen.getByRole("radio", { name: "요약 나중에 실행" }));
  // 1번째 클릭: 게이트 확인 + 장치 목록 표시. 아직 회의를 만들지 않는다.
  fireEvent.click(screen.getByRole("button", { name: "녹음 시작" }));
  await screen.findByLabelText("마이크");
  expect(post).not.toHaveBeenCalled();
  // 2번째 클릭: 실제 시작.
  fireEvent.click(screen.getByRole("button", { name: "녹음 시작" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith("m7"));
  expect(post).toHaveBeenCalledWith("/meetings/live", {
    title: "주간 회의",
    defer_summary: true,
  });
  // 성공하면 브라우저 레코더를 만들어 등록한다 — 종료가 이 인스턴스를 찾아야 한다.
  await waitFor(() => expect(getLiveRecorder("m7")).toBeDefined());
});

test("409면 이미 녹음 중이라는 토스트를 띄우고 닫지 않는다", async () => {
  stubMediaDevices();
  const { onStarted } = renderDialog();
  fireEvent.click(screen.getByRole("button", { name: "녹음 시작" }));
  await screen.findByLabelText("마이크");
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
