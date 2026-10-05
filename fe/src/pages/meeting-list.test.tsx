import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, expect, test, vi } from "vitest";

import type { WireMeeting, WireSpeaker } from "@/features/meeting/api/types";

const fx = vi.hoisted(() => ({
  meetings: [] as unknown[],
  speakers: [] as unknown[],
}));

vi.mock("@/shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/client")>()),
  apiClient: {
    get: vi.fn(async (url: string) => {
      if (url === "/meetings") return { data: fx.meetings };
      if (url === "/speakers") return { data: fx.speakers };
      if (url === "/folders")
        return {
          data: [
            {
              id: "fld_1",
              name: "기본 폴더",
              is_default: true,
              created_at: "2026-10-01T00:00:00.000Z",
            },
            {
              id: "fld_2",
              name: "기획팀",
              is_default: false,
              created_at: "2026-10-01T00:00:00.000Z",
            },
            {
              id: "fld_3",
              name: "빈 폴더",
              is_default: false,
              created_at: "2026-10-01T00:00:00.000Z",
            },
          ],
        };
      throw new Error(`unhandled GET ${url}`);
    }),
  },
}));

const { MeetingListPage } = await import("@/pages/meeting-list");

afterEach(cleanup);

function row(id: string, overrides: Partial<WireMeeting> = {}): WireMeeting {
  return {
    id,
    title: `회의 ${id}`,
    original_filename: null,
    audio_key: "k",
    normalized_key: null,
    recorded_at: "2026-09-01T10:00:00.000Z",
    duration_ms: 600_000,
    status: "done",
    is_favorite: false,
    current_job_id: null,
    processing_version: 1,
    error: null,
    created_at: "2026-09-01T10:00:00.000Z",
    tags: [],
    folder_id: "fld_1",
    ...overrides,
  };
}

const speaker = (id: string, isMe: boolean): WireSpeaker => ({
  id,
  name: id,
  enrollment_status: "ready",
  current_job_id: null,
  enrollment_error: null,
  created_at: "2026-06-01T00:00:00.000Z",
  is_me: isMe,
});

function Probe() {
  const { pathname, search } = useLocation();
  return <span>경로: {pathname + search}</span>;
}

function renderList(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Probe />
        <Routes>
          <Route path="/meetings" element={<MeetingListPage />} />
          <Route path="/folders/:folderId" element={<MeetingListPage />} />
          <Route path="/speakers" element={<p>화자 관리 화면</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const cardTitles = () =>
  screen
    .getAllByTestId("meeting-card")
    .map((card) => card.querySelector("a")!.textContent);

const tab = (name: string) => screen.getByRole("radio", { name });

test("폴더 경로는 그 폴더 회의만 제목·회의 수와 함께 보여 준다", async () => {
  fx.meetings = [
    row("m1", { folder_id: "fld_2" }),
    row("m2", { folder_id: "fld_2" }),
    row("m3", { folder_id: "fld_1" }),
  ];
  fx.speakers = [];
  renderList("/folders/fld_2");
  expect(
    await screen.findByRole("heading", { level: 1, name: "기획팀" }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("회의 2개")).toBeInTheDocument();
  expect(cardTitles().sort()).toEqual(["회의 m1", "회의 m2"]);
});

test("각 탭이 맞게 거르고, 탭을 바꾸면 URL에 실리고 페이지를 지운다", async () => {
  fx.meetings = [
    row("mine", { has_me: true }),
    row("decided", { decision_count: 1 }),
    row("starred", { is_favorite: true }),
  ];
  fx.speakers = [speaker("sp_me", true)];
  renderList("/meetings?page=2");
  await screen.findByRole("heading", { level: 1, name: "전체 회의" });
  expect(cardTitles()).toHaveLength(3);

  fireEvent.click(tab("내가 참여한 회의"));
  expect(
    await screen.findByText("경로: /meetings?tab=mine"),
  ).toBeInTheDocument();
  expect(cardTitles()).toEqual(["회의 mine"]);

  fireEvent.click(tab("결정 있는 회의"));
  expect(cardTitles()).toEqual(["회의 decided"]);

  fireEvent.click(tab("즐겨찾기"));
  expect(cardTitles()).toEqual(["회의 starred"]);

  fireEvent.click(tab("전체"));
  expect(screen.getByText("경로: /meetings")).toBeInTheDocument();
});

test("정렬: 최신순 · 오래된순 · 긴 회의순", async () => {
  fx.meetings = [
    row("a", { recorded_at: "2026-09-01T10:00:00.000Z", duration_ms: 600_000 }),
    row("b", { recorded_at: "2026-09-03T10:00:00.000Z", duration_ms: 300_000 }),
    row("c", {
      recorded_at: "2026-09-02T10:00:00.000Z",
      duration_ms: 3_600_000,
    }),
  ];
  fx.speakers = [];
  renderList("/meetings");
  await screen.findAllByTestId("meeting-card");
  expect(cardTitles()).toEqual(["회의 b", "회의 c", "회의 a"]);

  const pick = (label: string) => {
    const trigger = screen.getByRole("combobox", { name: "정렬" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: label }));
  };
  pick("오래된순");
  expect(
    await screen.findByText("경로: /meetings?sort=oldest"),
  ).toBeInTheDocument();
  expect(cardTitles()).toEqual(["회의 a", "회의 c", "회의 b"]);

  pick("긴 회의순");
  expect(cardTitles()).toEqual(["회의 c", "회의 a", "회의 b"]);
});

test("한 페이지는 20개 — 21번째 회의는 2페이지에 있고, 범위 밖 페이지는 마지막으로 본다", async () => {
  fx.meetings = Array.from({ length: 21 }, (_, i) =>
    row(`m${String(i + 1).padStart(2, "0")}`, {
      recorded_at: new Date(Date.UTC(2026, 8, 30 - i)).toISOString(),
    }),
  );
  fx.speakers = [];
  renderList("/meetings");
  await screen.findAllByTestId("meeting-card");
  expect(cardTitles()).toHaveLength(20);
  expect(screen.getByText("표시 중: 1–20 / 총 21개 회의")).toBeInTheDocument();
  expect(cardTitles()).not.toContain("회의 m21");

  fireEvent.click(screen.getByRole("button", { name: "다음" }));
  expect(await screen.findByText("경로: /meetings?page=2")).toBeInTheDocument();
  expect(cardTitles()).toEqual(["회의 m21"]);
  expect(screen.getByText("표시 중: 21–21 / 총 21개 회의")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "2페이지" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  cleanup();
  renderList("/meetings?page=9");
  await screen.findAllByTestId("meeting-card");
  expect(cardTitles()).toEqual(["회의 m21"]);
});

test("'나'가 없으면 내가 참여한 회의 탭은 화자 관리로 안내한다", async () => {
  fx.meetings = [row("m1")];
  fx.speakers = [speaker("sp_1", false)];
  renderList("/meetings?tab=mine");
  expect(
    await screen.findByText(
      "화자 관리에서 ‘나’를 지정하면 내가 참여한 회의만 모아 볼 수 있어요.",
    ),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: "화자 관리로 가기" }));
  expect(await screen.findByText("화자 관리 화면")).toBeInTheDocument();
});

test("없는 폴더는 찾을 수 없다고 하고 전체 회의 링크를 준다", async () => {
  fx.meetings = [row("m1")];
  fx.speakers = [];
  renderList("/folders/fld_gone");
  expect(await screen.findByText("폴더를 찾을 수 없어요")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: "전체 회의" }));
  expect(await screen.findByText("경로: /meetings")).toBeInTheDocument();
});

test("빈 폴더와 결과 없는 탭은 서로 다른 문구를 보인다", async () => {
  fx.meetings = [row("m1", { folder_id: "fld_2" })];
  fx.speakers = [];
  renderList("/folders/fld_3");
  expect(
    await screen.findByText("이 폴더에 회의가 없어요."),
  ).toBeInTheDocument();

  cleanup();
  renderList("/folders/fld_2?tab=fav");
  expect(
    await screen.findByText("조건에 맞는 회의가 없어요."),
  ).toBeInTheDocument();
});

test("카드는 메타 줄·집계 배지·미리보기를 그리고, 0인 배지와 처리 중 회의의 집계는 숨긴다", async () => {
  fx.meetings = [
    row("full", {
      title: "주간 회의",
      recorded_at: "2026-09-02T10:00:00.000Z",
      tags: [{ id: "t1", name: "프로젝트A" }],
      participant_count: 4,
      decision_count: 2,
      action_count: 3,
      saved_count: 5,
      preview_decision: "출시는 5월로 한다",
      preview_action: {
        text: "초안 공유",
        assignee_name: "박수민",
        due_at: "2026-04-02",
        done: false,
      },
      preview_summary: "쓰이지 않는 요약",
    }),
    row("bare", {
      title: "빈 회의",
      recorded_at: "2026-09-01T10:00:00.000Z",
      preview_summary: "일정만 논의했다",
    }),
    row("busy", {
      title: "처리 중 회의",
      recorded_at: "2026-08-31T10:00:00.000Z",
      status: "processing",
      decision_count: 1,
    }),
  ];
  fx.speakers = [];
  renderList("/meetings");
  const [full, bare, busy] = (await screen.findAllByTestId("meeting-card")).map(
    (card) => within(card),
  );

  expect(full.getByText("프로젝트A")).toBeInTheDocument();
  expect(full.getByText("4명")).toBeInTheDocument();
  expect(full.getByText("결정 2")).toBeInTheDocument();
  expect(full.getByText("할 일 3")).toBeInTheDocument();
  expect(full.getByLabelText("저장한 발언 5")).toBeInTheDocument();
  expect(full.getByText("출시는 5월로 한다")).toBeInTheDocument();
  expect(full.getByText("박수민 · 4월 2일까지 초안 공유")).toBeInTheDocument();
  expect(full.queryByText("쓰이지 않는 요약")).not.toBeInTheDocument();
  expect(
    full.getByRole("link", { name: "주간 회의 회의 열기" }),
  ).toHaveAttribute("href", "/meetings/full");
  expect(full.getByRole("link", { name: "주간 회의" })).toHaveAttribute(
    "href",
    "/meetings/full",
  );

  expect(bare.queryByText(/결정/)).not.toBeInTheDocument();
  expect(bare.queryByText(/할 일/)).not.toBeInTheDocument();
  expect(bare.queryByText(/명$/)).not.toBeInTheDocument();
  expect(bare.getByText("일정만 논의했다")).toBeInTheDocument();

  expect(busy.getByText("처리 중")).toBeInTheDocument();
  expect(busy.queryByText("결정 1")).not.toBeInTheDocument();
});
