import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { Meeting, UtteranceEntry } from "../model/types";

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

function utt(id: string, text: string, over: Partial<UtteranceEntry> = {}) {
  return {
    id,
    spk: 1,
    t: "00:00",
    text,
    status: "ok" as const,
    sources: [{ id, startMs: 0 }],
    ...over,
  };
}

const LOTUS = [
  utt("u1", "오디세우스가 로터스를 먹는다"),
  utt("u2", "로터스가 자라는 지역과 로터스 열매"),
];

function typeQuery(value: string) {
  const input = screen.getByRole("searchbox", { name: "이 회의에서 찾기" });
  fireEvent.change(input, { target: { value } });
  return input;
}

test("찾기 입력이 항상 보인다", () => {
  renderPane();
  expect(
    screen.getByRole("searchbox", { name: "이 회의에서 찾기" }),
  ).toBeInTheDocument();
});

test("질의가 비어 있으면 카운터와 이동 버튼이 없다", () => {
  renderPane({ utterances: LOTUS });
  expect(screen.queryByRole("button", { name: "다음 결과" })).toBeNull();
});

test("입력하면 모든 매칭을 표시하고 카운터가 1/n을 보여준다", () => {
  const { container } = renderPane({ utterances: LOTUS });
  typeQuery("로터스");
  expect(container.querySelectorAll("mark")).toHaveLength(3);
  expect(screen.getByText("1/3")).toBeInTheDocument();
});

test("현재 매칭에만 data-find-current가 붙는다", () => {
  const { container } = renderPane({ utterances: LOTUS });
  typeQuery("로터스");
  const current = container.querySelectorAll("[data-find-current]");
  expect(current).toHaveLength(1);
  expect(current[0]).toBe(container.querySelectorAll("mark")[0]);
});

test("대소문자를 무시하고 매칭한다", () => {
  const { container } = renderPane({
    utterances: [utt("u1", "the Lotus eaters")],
  });
  typeQuery("LOTUS");
  expect(container.querySelectorAll("mark")).toHaveLength(1);
  expect(container.querySelector("mark")?.textContent).toBe("Lotus");
});

test("İ가 섞여 있어도 마크 경계가 밀리지 않는다", () => {
  const { container } = renderPane({
    utterances: [utt("u1", "İstanbul 로터스 lotus")],
  });
  typeQuery("lotus");
  expect(container.querySelector("mark")?.textContent).toBe("lotus");
});

test("전사 실패 발화의 안내 문구는 매칭되지 않는다", () => {
  const { container } = renderPane({
    utterances: [utt("u1", "무시되는 원문", { status: "transcribe_failed" })],
  });
  typeQuery("구간");
  expect(container.querySelectorAll("mark")).toHaveLength(0);
  expect(screen.getByText("결과 없음")).toBeInTheDocument();
});

test("매칭이 없으면 이동 버튼이 비활성이다", () => {
  renderPane({ utterances: LOTUS });
  typeQuery("없는단어");
  expect(screen.getByRole("button", { name: "다음 결과" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "이전 결과" })).toBeDisabled();
});

test("✕를 누르면 질의와 하이라이트가 사라진다", () => {
  const { container } = renderPane({ utterances: LOTUS });
  typeQuery("로터스");
  fireEvent.click(screen.getByRole("button", { name: "찾기 지우기" }));
  expect(container.querySelectorAll("mark")).toHaveLength(0);
});

/** renderPane과 달리 meeting을 교체해 다시 그릴 수 있다(전사 갱신 재현용). */
function renderUpdatable(over: Partial<Meeting> = {}, onJump = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const ui = (next: Partial<Meeting>) => (
    <QueryClientProvider client={client}>
      <TranscriptPane
        meeting={meeting(next)}
        activeId=""
        onJump={onJump}
        onDeleted={vi.fn()}
        aiAcked
        onAckAi={vi.fn()}
        onShowSummary={vi.fn()}
      />
    </QueryClientProvider>
  );
  const result = render(ui(over));
  return {
    ...result,
    onJump,
    update: (next: Partial<Meeting>) => result.rerender(ui(next)),
  };
}

function currentMarkText(container: HTMLElement) {
  return container.querySelector("[data-find-current]")?.textContent;
}

test("다음 결과를 누르면 카운터와 현재 매칭이 함께 움직인다", () => {
  const { container } = renderPane({ utterances: LOTUS });
  typeQuery("로터스");
  fireEvent.click(screen.getByRole("button", { name: "다음 결과" }));
  expect(screen.getByText("2/3")).toBeInTheDocument();
  const marks = [...container.querySelectorAll("mark")];
  expect(container.querySelector("[data-find-current]")).toBe(marks[1]);
});

test("마지막 매칭에서 다음을 누르면 처음으로 순환한다", () => {
  const { container } = renderPane({ utterances: LOTUS });
  typeQuery("로터스");
  const next = screen.getByRole("button", { name: "다음 결과" });
  fireEvent.click(next);
  fireEvent.click(next);
  expect(screen.getByText("3/3")).toBeInTheDocument();
  fireEvent.click(next);
  expect(screen.getByText("1/3")).toBeInTheDocument();
  expect(container.querySelector("[data-find-current]")).toBe(
    container.querySelector("mark"),
  );
});

test("첫 매칭에서 이전을 누르면 마지막으로 순환한다", () => {
  renderPane({ utterances: LOTUS });
  typeQuery("로터스");
  fireEvent.click(screen.getByRole("button", { name: "이전 결과" }));
  expect(screen.getByText("3/3")).toBeInTheDocument();
});

test("이동해도 오디오·URL을 건드리지 않는다", () => {
  const { onJump } = renderUpdatable({ utterances: LOTUS });
  typeQuery("로터스");
  fireEvent.click(screen.getByRole("button", { name: "다음 결과" }));
  expect(onJump).not.toHaveBeenCalled();
});

test("현재 매칭을 화면 가운데로 스크롤한다", () => {
  const spy = vi.spyOn(Element.prototype, "scrollIntoView");
  const { container } = renderPane({ utterances: LOTUS });
  typeQuery("로터스");
  spy.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "다음 결과" }));
  const marks = [...container.querySelectorAll("mark")];
  expect(spy).toHaveBeenCalledWith({ block: "center" });
  expect(spy.mock.instances[spy.mock.instances.length - 1]).toBe(marks[1]);
  spy.mockRestore();
});

test("전사가 갱신돼도 같은 매칭이 살아 있으면 위치를 유지한다", () => {
  const { update } = renderUpdatable({ utterances: LOTUS });
  typeQuery("로터스");
  fireEvent.click(screen.getByRole("button", { name: "다음 결과" }));
  expect(screen.getByText("2/3")).toBeInTheDocument();

  // 같은 내용의 새 배열 — 재조회가 동일 데이터를 돌려주는 흔한 경우.
  update({ utterances: LOTUS.map((u) => ({ ...u })) });
  expect(screen.getByText("2/3")).toBeInTheDocument();
});

test("현재 매칭이 사라진 전사로 갱신되면 카운터와 하이라이트가 함께 앞으로 간다", () => {
  const { container, update } = renderUpdatable({ utterances: LOTUS });
  typeQuery("로터스");
  fireEvent.click(screen.getByRole("button", { name: "다음 결과" }));
  expect(screen.getByText("2/3")).toBeInTheDocument();

  // u2가 "로터스" 하나만 남도록 재처리된 상황 — 매칭 3개 → 2개.
  // (u2 텍스트 앞에 "이제 "를 붙여 오프셋을 옮긴다 — 원문 그대로 "로터스만
  // 남았다"를 쓰면 새 매칭이 옛 앵커와 uid·start·end가 우연히 겹쳐 "사라진
  // 매칭" 시나리오를 실제로 재현하지 못한다.)
  update({ utterances: [LOTUS[0], utt("u2", "이제 로터스만 남았다")] });
  expect(screen.getByText("1/2")).toBeInTheDocument();
  expect(container.querySelectorAll("[data-find-current]")).toHaveLength(1);
  expect(currentMarkText(container)).toBe("로터스");
});
