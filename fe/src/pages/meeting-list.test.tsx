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
  lenses: {} as Record<string, { items: unknown[]; total: number }>,
  lensUrls: [] as string[],
}));

vi.mock("@/shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/client")>()),
  apiClient: {
    get: vi.fn(async (url: string) => {
      if (url === "/meetings") return { data: fx.meetings };
      if (url === "/speakers") return { data: fx.speakers };
      if (url.startsWith("/lenses?")) {
        fx.lensUrls.push(url);
        const kind = new URLSearchParams(url.split("?")[1]).get("kind")!;
        return {
          data: {
            next_cursor: null,
            ...(fx.lenses[kind] ?? { items: [], total: 0 }),
          },
        };
      }
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

afterEach(() => {
  cleanup();
  fx.lenses = {};
  fx.lensUrls = [];
});

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

const dated = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    row(`m${String(i + 1).padStart(2, "0")}`, {
      recorded_at: new Date(Date.UTC(2026, 8, 30 - i)).toISOString(),
    }),
  );

test("한 페이지는 기본 10개 — 11번째 회의는 2페이지에 있고, 범위 밖 페이지는 마지막으로 본다", async () => {
  fx.meetings = dated(11);
  fx.speakers = [];
  renderList("/meetings");
  await screen.findAllByTestId("meeting-card");
  expect(cardTitles()).toHaveLength(10);
  expect(screen.getByText("표시 중: 1–10 / 총 11개 회의")).toBeInTheDocument();
  expect(cardTitles()).not.toContain("회의 m11");

  fireEvent.click(screen.getByRole("button", { name: "다음" }));
  expect(await screen.findByText("경로: /meetings?page=2")).toBeInTheDocument();
  expect(cardTitles()).toEqual(["회의 m11"]);
  expect(screen.getByText("표시 중: 11–11 / 총 11개 회의")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "2페이지" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  cleanup();
  renderList("/meetings?page=9");
  await screen.findAllByTestId("meeting-card");
  expect(cardTitles()).toEqual(["회의 m11"]);
});

test("페이지 크기는 10·20·30개 중 고르고, 바꾸면 URL에 실리고 1페이지로 돌아간다", async () => {
  fx.meetings = dated(25);
  fx.speakers = [];
  renderList("/meetings?page=2");
  await screen.findAllByTestId("meeting-card");
  expect(cardTitles()).toHaveLength(10);

  const pick = (label: string) => {
    const trigger = screen.getByRole("combobox", { name: "페이지당 회의 수" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: label }));
  };
  pick("20개씩");
  expect(
    await screen.findByText("경로: /meetings?size=20"),
  ).toBeInTheDocument();
  expect(cardTitles()).toHaveLength(20);
  expect(screen.getByText("표시 중: 1–20 / 총 25개 회의")).toBeInTheDocument();

  pick("30개씩");
  expect(
    await screen.findByText("경로: /meetings?size=30"),
  ).toBeInTheDocument();
  expect(cardTitles()).toHaveLength(25);
  expect(screen.queryByRole("navigation", { name: "페이지" })).toBeNull();

  pick("10개씩");
  expect(await screen.findByText("경로: /meetings")).toBeInTheDocument();
  expect(cardTitles()).toHaveLength(10);
});

test("모르는 페이지 크기는 기본 10개로 본다", async () => {
  fx.meetings = dated(25);
  fx.speakers = [];
  renderList("/meetings?size=7");
  await screen.findAllByTestId("meeting-card");
  expect(cardTitles()).toHaveLength(10);
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

test("빈 폴더는 드롭존만 크게 보이고, 결과 없는 탭은 조건 문구를 보인다", async () => {
  fx.meetings = [row("m1", { folder_id: "fld_2" })];
  fx.speakers = [];
  renderList("/folders/fld_3");
  await screen.findByRole("heading", { level: 1, name: "빈 폴더" });
  expect(screen.getByRole("region", { name: "녹음 파일 올리기" })).toHaveClass(
    "flex-col",
  );
  expect(
    screen.queryByRole("region", { name: "최근 결정" }),
  ).not.toBeInTheDocument();
  expect(fx.lensUrls).toEqual([]);

  cleanup();
  renderList("/folders/fld_2?tab=fav");
  expect(
    await screen.findByText("조건에 맞는 회의가 없어요."),
  ).toBeInTheDocument();
});

const lens = (
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  kind: "decision",
  text: `항목 ${id}`,
  source: "ai",
  user_modified: false,
  completion_status: "open",
  lifecycle_status: "active",
  meeting_id: "m1",
  assignee_speaker_id: null,
  due_at: null,
  created_at: "2026-09-01T10:00:00.000Z",
  updated_at: "2026-09-01T10:00:00.000Z",
  meeting: { id: "m1", title: "로드맵 회의", recorded_at: null },
  evidence: [],
  ...overrides,
});

const todayYmd = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

test("폴더 목록은 그 폴더의 최근 결정·진행 중인 할 일을 건수와 함께 보여 준다", async () => {
  fx.meetings = [row("m1", { folder_id: "fld_2" })];
  fx.speakers = [speaker("spk_1", false), speaker("박수민", false)];
  fx.lenses = {
    decision: {
      total: 3,
      items: [
        lens("l1", {
          text: "OAuth는 PKCE로 간다",
          evidence: [
            {
              relation: "primary",
              utterance: {
                id: "utt_9",
                start_ms: 1_902_000,
                text: "t",
                speaker_id: null,
              },
            },
          ],
        }),
      ],
    },
    action: {
      total: 5,
      items: [
        lens("l2", {
          kind: "action",
          text: "단축키 프로토타입",
          assignee_speaker_id: "박수민",
          due_at: todayYmd(),
        }),
      ],
    },
  };
  renderList("/folders/fld_2");

  const decisions = within(
    await screen.findByRole("region", { name: "최근 결정" }),
  );
  expect(
    await decisions.findByText("“OAuth는 PKCE로 간다”"),
  ).toBeInTheDocument();
  expect(decisions.getByLabelText("최근 결정 3건")).toBeInTheDocument();
  expect(
    decisions.getByRole("link", { name: "회의에서 보기 31:42" }),
  ).toHaveAttribute("href", "/meetings/m1?u=utt_9");
  expect(decisions.getByRole("link", { name: /모두 보기/ })).toHaveAttribute(
    "href",
    "/lenses/decision",
  );

  const actions = within(
    screen.getByRole("region", { name: "진행 중인 할 일" }),
  );
  expect(await actions.findByText("단축키 프로토타입")).toBeInTheDocument();
  expect(actions.getByLabelText("진행 중인 할 일 5건")).toBeInTheDocument();
  expect(actions.getByText("D-Day")).toBeInTheDocument();
  expect(actions.getByRole("img", { name: "박수민" })).toBeInTheDocument();

  expect(fx.lensUrls).toHaveLength(2);
  for (const url of fx.lensUrls) {
    const q = new URLSearchParams(url.split("?")[1]);
    expect(q.get("folder_id")).toBe("fld_2");
    expect(q.get("completion_status")).toBe("open");
  }
});

test("전체 회의 목록의 요약은 폴더로 거르지 않는다", async () => {
  fx.meetings = [row("m1")];
  fx.speakers = [];
  renderList("/meetings");
  expect(
    await screen.findByText("진행 중인 할 일이 없어요."),
  ).toBeInTheDocument();
  expect(fx.lensUrls.length).toBeGreaterThan(0);
  for (const url of fx.lensUrls) expect(url).not.toContain("folder_id");
});

test("드롭존에 놓은 오디오 파일은 바로 올리지 않고 그 파일을 채운 새 회의 모달을 연다", async () => {
  fx.meetings = [row("m1", { folder_id: "fld_2" })];
  fx.speakers = [];
  renderList("/folders/fld_2");
  const zone = await screen.findByRole("region", { name: "녹음 파일 올리기" });

  const image = new File(["x"], "photo.png", { type: "image/png" });
  fireEvent.drop(zone, { dataTransfer: { files: [image], types: ["Files"] } });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  const audio = new File(["a"], "주간.m4a", { type: "audio/mp4" });
  fireEvent.drop(zone, { dataTransfer: { files: [audio], types: ["Files"] } });
  const dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByText(/주간\.m4a/)).toBeInTheDocument();
  expect(dialog.getByRole("tab", { name: "오디오 파일" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("실시간 녹음 시작은 새 회의 모달을 실시간 녹음 탭으로 연다", async () => {
  fx.meetings = [row("m1")];
  fx.speakers = [];
  renderList("/meetings");
  fireEvent.click(
    await screen.findByRole("button", { name: /실시간 녹음 시작/ }),
  );
  const dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByRole("tab", { name: "실시간 녹음" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
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
