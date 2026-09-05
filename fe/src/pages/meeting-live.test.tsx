import {
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

let current: WireMeeting = meeting({});
let live: WireLiveResponse = {
  status: "recording",
  stage: "capture",
  heartbeat_at: new Date().toISOString(),
  items: [],
};

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
      utterances: [],
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
  vi.spyOn(apiClient, "get").mockImplementation(
    (url: string) => getResponse(url) as never,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
