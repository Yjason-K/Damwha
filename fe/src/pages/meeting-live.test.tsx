import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { routes } from "@/app/router";
import { apiClient } from "@/shared/api/client";
import type {
  WireLiveResponse,
  WireMeeting,
  WireMeetingDetail,
  WireUtterance,
} from "@/features/meeting/api/types";

const meeting = (o: Partial<WireMeeting>): WireMeeting => ({
  id: "m1",
  title: "지금 회의",
  original_filename: null,
  audio_key: "meetings/m1/original.wav",
  normalized_key: null,
  recorded_at: "2026-09-05T10:00:00.000Z",
  duration_ms: null,
  status: "recording",
  is_favorite: false,
  current_job_id: "job_1",
  processing_version: 0,
  error: null,
  created_at: "2026-09-05T10:00:00.000Z",
  ...o,
});

const utt = (o: Partial<WireUtterance>): WireUtterance => ({
  id: "u0",
  meeting_id: "m1",
  speaker_id: null,
  diar_label: "SPEAKER_00",
  start_ms: 0,
  end_ms: 0,
  text: "",
  confidence: null,
  status: "ok",
  transcript_error: null,
  order_index: 0,
  processing_version: 0,
  job_id: null,
  speaker_name: null,
  speaker_status: null,
  ...o,
});

let current: WireMeeting = meeting({});
let live: WireLiveResponse = {
  status: "recording",
  stage: "capture",
  heartbeat_at: new Date().toISOString(),
  items: [],
};
// 실제 전사(발화)가 있는 회의를 그리는 케이스(우선순위 테스트)만 채운다 — 기본은 빈 배열.
let currentUtterances: WireUtterance[] = [];

function getResponse(url: string) {
  if (url === "/meetings") return Promise.resolve({ data: [current] });
  if (url === "/settings/processing")
    return Promise.resolve({
      data: {
        preset: "standard",
        preset_revision: "2026-08-12.3",
        language: "ko",
        whisper_model: "large-v3-turbo",
        devices: { diarization: "gpu", stt: "gpu" },
        summary_model: "mlx-community/Qwen3.5-9B-8bit",
      },
    });
  if (url === "/lenses/extraction-status")
    return Promise.resolve({ data: { running: 0, failed: [] } });
  if (url === "/meetings/m1/lenses")
    return Promise.resolve({ data: { items: [], extraction_status: null } });
  if (url === "/meetings/m1/note")
    return Promise.resolve({ data: { note: null } });
  // ResolveDialog(회의 전사 패널 안의 다이얼로그)가 마운트 시 useSpeakers()를
  // 호출해 /speakers를 조회한다 — 실패 회의 케이스도 TranscriptPane을 그리므로
  // 이 라우트가 없으면 unhandled-route 에러로 테스트가 무관한 이유로 깨진다.
  if (url === "/speakers") return Promise.resolve({ data: [] });
  if (url === "/meetings/m1/status")
    return Promise.resolve({
      data: {
        status: current.status,
        stage: live.stage,
        progress: 0,
        error: current.error,
        summary: null,
        search_index: null,
      },
    });
  if (url === "/meetings/m1/live") return Promise.resolve({ data: live });
  if (url === "/meetings/m1") {
    const detail: WireMeetingDetail = {
      ...current,
      utterances: currentUtterances,
      clusters: [],
      summary: null,
    };
    return Promise.resolve({ data: detail });
  }
  return Promise.reject(new Error(`unhandled GET ${url}`));
}

beforeEach(() => {
  current = meeting({});
  live = {
    status: "recording",
    stage: "capture",
    heartbeat_at: new Date().toISOString(),
    items: [],
  };
  currentUtterances = [];
  getSpy = vi
    .spyOn(apiClient, "get")
    .mockImplementation((url: string) => getResponse(url) as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

let getSpy: { mock: { calls: unknown[][] } };
const statusCalls = () =>
  getSpy.mock.calls.filter((c) => c[0] === "/meetings/m1/status").length;

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("녹음 중인 회의는 라이브 배너와 라이브 전사를 그리고 플레이바는 없다", async () => {
  live.items = [
    {
      id: "lut_1",
      seq: 0,
      start_ms: 0,
      end_ms: 800,
      text: "첫 발화예요",
      speaker_id: "sp_1",
      speaker_name: "영재",
      similarity: 0.82,
    },
  ];
  renderAt("/meetings/m1");
  expect(await screen.findByText("첫 발화예요")).toBeInTheDocument();
  expect(screen.getByRole("status", { name: /녹음/ })).toHaveTextContent(
    "녹음 중",
  );
  expect(screen.getByRole("button", { name: "종료" })).toBeInTheDocument();
  expect(screen.queryByRole("slider")).toBeNull();
  expect(
    screen.getByText("녹음이 끝나면 요약과 렌즈가 만들어져요"),
  ).toBeInTheDocument();
});

test("종료를 누르면 stop을 호출하고 버튼이 잠긴다", async () => {
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({
    data: { meeting_id: "m1", job_id: "job_1", outcome: "stopping" },
  } as never);
  renderAt("/meetings/m1");
  const btn = await screen.findByRole("button", { name: "종료" });
  btn.click();
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith("/meetings/m1/live/stop"),
  );
});

test("실패한 회의에 라이브 행이 남아 있으면 읽기 전용 미리보기를 그린다", async () => {
  current = meeting({
    status: "failed",
    error: { code: "stale_worker", message: "worker lost" },
  });
  live = {
    status: "failed",
    stage: "capture",
    heartbeat_at: null,
    items: [
      {
        id: "lut_1",
        seq: 0,
        start_ms: 0,
        end_ms: 800,
        text: "남은 발화",
        speaker_id: null,
        speaker_name: null,
        similarity: null,
      },
    ],
  };
  renderAt("/meetings/m1");
  expect(await screen.findByText("남은 발화")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("처리에 실패했어요");
  expect(
    screen.getByRole("button", { name: "회의 재처리" }),
  ).toBeInTheDocument();
});

test("마이크를 못 연 실패는 권한 안내를 보여주고 재처리 버튼을 숨긴다", async () => {
  current = meeting({
    status: "failed",
    error: { code: "audio_device_failed", message: "no mic" },
  });
  live = { status: "failed", stage: null, heartbeat_at: null, items: [] };
  renderAt("/meetings/m1");
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("마이크를 열지 못했어요")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "회의 재처리" })).toBeNull();
});

// 리뷰 회귀 1: '종료' 뒤 done이 되기 전(uploaded/processing)에도 실제 전사가
// 아직 없으므로 라이브 미리보기가 이어져야 한다 — status==="failed"로만
// 좁혀져 있던 예전 배선에서는 이 케이스가 빈 화면이었다.
test("처리 중인 회의는 실제 전사가 없으면 라이브 미리보기를 이어서 그린다", async () => {
  current = meeting({ status: "processing", error: null });
  live = {
    status: "processing",
    stage: "stt",
    heartbeat_at: null,
    items: [
      {
        id: "lut_1",
        seq: 0,
        start_ms: 0,
        end_ms: 800,
        text: "처리 중에도 남아 있는 발화",
        speaker_id: null,
        speaker_name: null,
        similarity: null,
      },
    ],
  };
  renderAt("/meetings/m1");
  expect(
    await screen.findByText("처리 중에도 남아 있는 발화"),
  ).toBeInTheDocument();
});

// 리뷰 회귀 2 (우선순위 고정): 재처리 실패라도 이전 처리 버전의 실제 전사가
// 남아 있으면 그 전사가 이긴다 — TranscriptPane의 "utterances.length === 0"
// 가드에 기대는 것이지 여기서 새 분기를 만들지 않는다.
test("실제 전사가 남아 있는 실패는 라이브 미리보기 대신 전사를 그린다", async () => {
  current = meeting({
    status: "failed",
    error: { code: "worker_crashed", message: "oops" },
  });
  currentUtterances = [utt({ id: "u1", text: "이전 버전의 실제 전사" })];
  live = {
    status: "failed",
    stage: "stt",
    heartbeat_at: null,
    items: [
      {
        id: "lut_1",
        seq: 0,
        start_ms: 0,
        end_ms: 800,
        text: "이번 실패의 라이브 미리보기",
        speaker_id: null,
        speaker_name: null,
        similarity: null,
      },
    ],
  };
  renderAt("/meetings/m1");
  expect(await screen.findByText("이전 버전의 실제 전사")).toBeInTheDocument();
  expect(screen.queryByText("이번 실패의 라이브 미리보기")).toBeNull();
});

// 리뷰 회귀 3 (I2): useMeetingStatus는 폴링 지속 여부를 자기 마지막 응답으로 정하는데,
// 녹음 중 그 응답은 늘 recording이다. 그 상태가 active 집합에서 빠져 있으면 폴링이
// 거기서 멈추고 아무도 다시 깨우지 않아, 종료 뒤 배치 패스 내내 배너가 "처리 중 · 0%"에
// 박힌다. 상태 하나를 고정해 간격만 보는 테스트로는 잡히지 않는다 — 전이를 태워야 한다.
test("녹음에서 처리로 넘어가도 상태 폴링이 이어진다", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  renderAt("/meetings/m1");
  expect(
    await screen.findByRole("status", { name: "녹음 상태" }),
  ).toHaveTextContent("녹음 중");
  await waitFor(() => expect(statusCalls()).toBeGreaterThan(0));
  const before = statusCalls();

  // 워커가 finalize했다 — 회의는 uploaded를 지나 배치 패스로 들어간다.
  current = meeting({ status: "processing" });
  live = { ...live, status: "processing", stage: "stt" };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });

  expect(statusCalls()).toBeGreaterThan(before);
  // 낡은 capture 응답이 아니라 방금 받은 배치 stage를 그린다.
  expect(screen.getByText("받아쓰기 · 0%")).toBeInTheDocument();
});

// 리뷰 회귀 4 (I4): 워커가 죽은 상태에서 stop은 job에 플래그만 찍는다 — 읽을 워커가
// 없으니 회의는 reaper의 stale 창(30분)까지 recording으로 남고, 그동안
// meeting_single_recording_idx가 새 녹음을 막는다. cancel만이 즉시 풀어준다.
test("워커 신호가 끊긴 배너의 버튼은 cancel을 호출한다", async () => {
  live = {
    ...live,
    heartbeat_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  };
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({
    data: { meeting_id: "m1", job_id: "job_1", status: "failed" },
  } as never);
  renderAt("/meetings/m1");
  const btn = await screen.findByRole("button", { name: "녹음 취소" });
  btn.click();
  await waitFor(() => expect(post).toHaveBeenCalledWith("/meetings/m1/cancel"));
  expect(post).not.toHaveBeenCalledWith("/meetings/m1/live/stop");
});
