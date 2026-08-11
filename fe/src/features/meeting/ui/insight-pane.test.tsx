import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InsightPane } from "./insight-pane";
import type { LensEntry, LensKind, Meeting } from "../model/types";

// vitest는 globals 없이 돌므로 RTL 자동 cleanup이 걸리지 않는다 — 명시 등록.
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

const NO_LENSES: Partial<Record<LensKind, LensEntry[]>> = {};

function renderPane(
  props: Partial<React.ComponentProps<typeof InsightPane>> = {},
) {
  const merged = {
    meeting: meeting(),
    lenses: NO_LENSES,
    tab: "summary",
    onTab: vi.fn(),
    done: {},
    onToggle: vi.fn(),
    onOpenLens: vi.fn(),
    onJumpSegment: vi.fn(),
    onRegenerateSummary: vi.fn(),
    regenerating: false,
    ...props,
  };
  render(<InsightPane {...merged} />);
  return merged;
}

describe("InsightPane", () => {
  it("탭은 요약·파일·메모 세 개다", () => {
    renderPane();
    expect(screen.getByRole("tab", { name: "요약" })).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "참석자" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /파일/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "메모" })).toBeInTheDocument();
  });

  it("주요 주제를 불릿 목록으로 보여준다", () => {
    renderPane({
      meeting: meeting({ topics: ["파이프라인 실행 순서", "예약 관리"] }),
    });
    expect(screen.getByText("파이프라인 실행 순서")).toBeInTheDocument();
    expect(screen.getByText("예약 관리")).toBeInTheDocument();
  });

  it("결과가 없는 핵심 결정 블록은 렌더하지 않는다", () => {
    renderPane();
    expect(screen.queryByText("핵심 결정")).not.toBeInTheDocument();
  });

  it("렌즈가 있으면 할 일과 결정 블록을 채운다", () => {
    renderPane({
      lenses: {
        action: [
          { id: "l1", text: "실행 로그 작성", source: "ai", ev: "utt_1" },
        ],
        decision: [{ id: "l2", text: "v2로 한정", source: "ai", ev: "utt_2" }],
      },
    });
    expect(screen.getByText("실행 로그 작성")).toBeInTheDocument();
    expect(screen.getByText("v2로 한정")).toBeInTheDocument();
  });

  it("단락은 접힌 채로 시작하고 행을 누르면 불릿이 펼쳐진다", () => {
    renderPane({
      meeting: meeting({
        segments: [
          {
            id: "utt_1",
            startUtteranceId: "utt_1",
            t: "01:07",
            title: "티켓 등록 수정",
            bullets: ["공유를 해드릴 것임"],
          },
        ],
      }),
    });
    expect(screen.queryByText("공유를 해드릴 것임")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /티켓 등록 수정/ }));
    expect(screen.getByText("공유를 해드릴 것임")).toBeInTheDocument();
  });

  it("단락의 시각을 누르면 펼치지 않고 점프한다", () => {
    const props = renderPane({
      meeting: meeting({
        segments: [
          {
            id: "utt_1",
            startUtteranceId: "utt_1",
            t: "01:07",
            title: "티켓 등록 수정",
            bullets: ["공유를 해드릴 것임"],
          },
        ],
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "01:07로 이동" }));
    expect(props.onJumpSegment).toHaveBeenCalledWith("utt_1");
    expect(screen.queryByText("공유를 해드릴 것임")).not.toBeInTheDocument();
  });

  it("요약 생성 중이면 진행 상태를 알린다", () => {
    renderPane({
      meeting: meeting({ summaryStatus: "running", topics: [], segments: [] }),
    });
    const status = screen.getByRole("status");
    expect(
      within(status).getByText("요약을 만들고 있어요"),
    ).toBeInTheDocument();
  });

  it("요약이 실패하면 재생성 버튼을 누를 수 있다", () => {
    const props = renderPane({ meeting: meeting({ summaryStatus: "failed" }) });
    fireEvent.click(screen.getByRole("button", { name: "요약 다시 만들기" }));
    expect(props.onRegenerateSummary).toHaveBeenCalled();
  });

  it("요약이 한 번도 없던 회의는 만들기 버튼을 준다", () => {
    const props = renderPane({ meeting: meeting({ summaryStatus: null }) });
    fireEvent.click(screen.getByRole("button", { name: "요약 만들기" }));
    expect(props.onRegenerateSummary).toHaveBeenCalled();
  });

  it("요약 생성 중에는 할 일 블록이 그대로 남는다", () => {
    renderPane({
      meeting: meeting({ summaryStatus: "running" }),
      lenses: {
        action: [
          { id: "l1", text: "실행 로그 작성", source: "ai", ev: "utt_1" },
        ],
      },
    });
    expect(screen.getByText("실행 로그 작성")).toBeInTheDocument();
  });
});
