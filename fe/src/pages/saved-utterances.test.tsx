import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { SavedUtterancesPage } from "./saved-utterances";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// jsdom에는 IntersectionObserver가 없다 — 다음 페이지가 남은 목록은 센티널을 관찰한다.
beforeAll(() => {
  vi.stubGlobal("IntersectionObserver", class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
    root = null; rootMargin = ""; thresholds = [];
  });
});

const 강형욱 = { id: "mtg_2", title: "강아지와 아기 함께 키우기", recorded_at: "2026-08-21T01:00:00Z" };
const 회고 = { id: "mtg_1", title: "회고", recorded_at: "2026-08-18T01:00:00Z" };

const saved = (id: string, meeting: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({ id, utterance_id: `utt_${id.slice(4)}`, text: `발언 ${id}`, speaker_id: "spk_1", speaker_name: "조승연", start_ms: 3_000, created_at: "2026-08-24T00:00:00Z", meeting, ...over });

const SPEAKERS = [{ id: "spk_1", name: "조승연", enrollment_status: "ready", created_at: "2026-08-01T00:00:00Z" }];

function renderPage(items: Record<string, unknown>[], nextCursor: string | null = null) {
  vi.spyOn(apiClient, "get").mockImplementation((async (url: string) =>
    url.startsWith("/speakers") ? { data: SPEAKERS } : { data: { items, next_cursor: nextCursor } }) as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><SavedUtterancesPage /></MemoryRouter></QueryClientProvider>);
}

test("발언 행은 시각·화자·본문을 보여주고 행 전체가 원문으로 가는 링크다", async () => {
  renderPage([saved("sav_4", 강형욱, { text: "아기 아닙니까? 그죠" })]);
  const link = await screen.findByRole("link", { name: "아기 아닙니까? 그죠" });
  expect(link).toHaveAttribute("href", "/meetings/mtg_2?u=utt_4");
  expect(screen.getByText("00:03")).toBeInTheDocument();
  expect(screen.getByText("조승연")).toBeInTheDocument();
});

test("원문으로 가는 조작은 버튼이 아니다", async () => {
  renderPage([saved("sav_4", 강형욱)]);
  expect(await screen.findByText("발언 sav_4")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /원문/ })).not.toBeInTheDocument();
});

test("저장 해제는 아이콘 버튼이다", async () => {
  renderPage([saved("sav_4", 강형욱)]);
  expect(await screen.findByRole("button", { name: "저장 해제" })).toBeInTheDocument();
});

test("발화가 사라진 항목은 링크가 아니라 본문만 남는다", async () => {
  renderPage([saved("sav_4", 강형욱, { utterance_id: null, text: "남아 있는 기록", speaker_id: null })]);
  expect(await screen.findByText("남아 있는 기록")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "남아 있는 기록" })).not.toBeInTheDocument();
});

test("회의가 바뀔 때마다 머리글을 한 번씩만 세운다", async () => {
  renderPage([saved("sav_3", 강형욱), saved("sav_2", 강형욱), saved("sav_1", 회고)]);
  expect(await screen.findByText("발언 sav_3")).toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: "강아지와 아기 함께 키우기" })).toHaveLength(1);
  expect(screen.getAllByRole("link", { name: "회고" })).toHaveLength(1);
});

test("머리글은 회의 상세로 가는 링크이고 날짜와 저장 개수를 함께 보여준다", async () => {
  renderPage([saved("sav_2", 강형욱), saved("sav_1", 강형욱)]);
  expect(await screen.findByText("발언 sav_2")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "강아지와 아기 함께 키우기" })).toHaveAttribute("href", "/meetings/mtg_2");
  expect(screen.getByText("2026.08.21 · 저장된 발언 2개")).toBeInTheDocument();
});

test("다음 페이지가 남아 있으면 마지막 그룹의 개수는 감춘다", async () => {
  renderPage([saved("sav_3", 강형욱), saved("sav_2", 회고), saved("sav_1", 회고)], "cursor");
  expect(await screen.findByText("발언 sav_3")).toBeInTheDocument();
  // 앞 그룹은 다음 회의가 시작된 시점에 이미 닫혔으므로 개수가 확정이다.
  expect(screen.getByText("2026.08.21 · 저장된 발언 1개")).toBeInTheDocument();
  // 마지막 그룹은 더 받을 항목이 남아 있어 개수를 말할 수 없다.
  expect(screen.getByText("2026.08.18")).toBeInTheDocument();
});
