import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { Meeting } from "../model/types";

// ResolveDialog가 useSpeakers()를, 헤더 액션들이 mutation을 쓰므로 클라이언트를
// 목킹한다. isApiError도 같은 모듈에서 오므로 함께 내보낸다.
vi.mock("@/shared/api/client", () => ({
  apiClient: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
  isApiError: () => false,
}));

const { TranscriptPane } = await import("./transcript-pane");

afterEach(cleanup);

function meeting(over: Partial<Meeting> = {}): Meeting {
  return {
    id: "mtg_1",
    title: "기획 회의",
    date: "2026-08-11",
    dur: "10:00",
    timeRange: "10:00–10:10",
    files: [],
    aiCount: 0,
    aiHeadline: "",
    aiDetail: "",
    attendees: [1],
    unverified: [],
    fav: false,
    tracks: [],
    utterances: [],
    topics: [],
    segments: [],
    summaryStatus: "done",
    status: "done",
    audioUrl: "",
    totalSeconds: 600,
    speakers: { 1: { id: "spk_1", name: "김영재", role: "PM", spk: 1 } },
    clusters: [],
    ...over,
  };
}

function renderPane(over: Partial<Meeting> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TranscriptPane
        meeting={meeting(over)}
        activeId=""
        onJump={vi.fn()}
        onDeleted={vi.fn()}
        aiAcked
        onAckAi={vi.fn()}
        onShowSummary={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

test("배선되지 않은 헤더 우측 버튼을 렌더하지 않는다", () => {
  renderPane();
  expect(screen.queryByRole("button", { name: "공유" })).toBeNull();
  expect(screen.queryByRole("button", { name: "더보기" })).toBeNull();
  expect(screen.queryByRole("button", { name: "저장" })).toBeNull();
});

test("동작하는 헤더 버튼은 남아 있다", () => {
  renderPane();
  expect(screen.getByRole("button", { name: "즐겨찾기" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "이름 변경" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "삭제" })).toBeInTheDocument();
});

test("하단 툴바의 중복·오작동 버튼을 렌더하지 않는다", () => {
  renderPane();
  expect(screen.queryByRole("button", { name: "발언 검색" })).toBeNull();
  expect(screen.queryByRole("button", { name: "전체 스크롤" })).toBeNull();
});
