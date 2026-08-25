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
    summaryError: null,
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
    summaryModel: undefined,
    onSummaryModelChange: vi.fn(),
    regenerating: false,
    // 기본은 "이 버전에서 추출을 이미 돌렸고 끝났다" — 대부분의 케이스가
    // 렌즈 실행 안내와 무관하므로 그 블록이 끼어들지 않게 한다.
    lensExtractionStatus: "done" as const,
    onExtractLenses: vi.fn(),
    extracting: false,
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
          {
            id: "l1",
            text: "실행 로그 작성",
            source: "ai",
            ev: "utt_1",
            done: false,
          },
        ],
        decision: [
          {
            id: "l2",
            text: "v2로 한정",
            source: "ai",
            ev: "utt_2",
            done: false,
          },
        ],
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

  it("요약 실패 사유가 있으면 함께 보여준다", () => {
    // 상태 엔드포인트가 flat string이던 시절엔 실을 자리가 없던 값이다
    renderPane({
      meeting: meeting({
        summaryStatus: "failed",
        summaryError: { code: "llm_request_failed", message: "timed out" },
      }),
    });
    expect(screen.getByText("timed out")).toBeInTheDocument();
  });

  it("사유 없는 요약 실패는 실패 문구만 보여준다", () => {
    renderPane({ meeting: meeting({ summaryStatus: "failed" }) });
    expect(screen.getByText("요약을 만들지 못했어요.")).toBeInTheDocument();
  });

  it("요약이 한 번도 없던 회의는 만들기 버튼을 준다", () => {
    const props = renderPane({ meeting: meeting({ summaryStatus: null }) });
    fireEvent.click(screen.getByRole("button", { name: "요약 만들기" }));
    expect(props.onRegenerateSummary).toHaveBeenCalled();
  });

  it("회의 처리가 끝나지 않았으면 요약 만들기 버튼 대신 안내만 보여준다", () => {
    renderPane({
      meeting: meeting({ status: "processing", summaryStatus: null }),
    });
    expect(
      screen.getByText("대화 처리가 끝나야 요약을 만들 수 있어요."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "요약 만들기" }),
    ).not.toBeInTheDocument();
  });

  it("회의 처리가 끝나지 않았으면 이전에 실패한 요약이 있어도 다시 만들기 버튼을 주지 않는다", () => {
    renderPane({
      meeting: meeting({ status: "uploaded", summaryStatus: "failed" }),
    });
    expect(
      screen.queryByRole("button", { name: "요약 다시 만들기" }),
    ).not.toBeInTheDocument();
  });

  it("추출을 미뤄둔 회의(status null)는 지금 찾기 버튼을 준다", () => {
    const props = renderPane({ lensExtractionStatus: null });
    expect(
      screen.getByText("아직 할 일과 결정을 찾지 않았어요."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "지금 찾기" }));
    expect(props.onExtractLenses).toHaveBeenCalled();
  });

  it("추출이 실패하면 다시 찾기 버튼을 준다", () => {
    const props = renderPane({ lensExtractionStatus: "failed" });
    fireEvent.click(screen.getByRole("button", { name: "다시 찾기" }));
    expect(props.onExtractLenses).toHaveBeenCalled();
  });

  it("추출이 도는 동안에는 버튼 대신 진행 상태만 보여준다", () => {
    renderPane({ lensExtractionStatus: "queued" });
    expect(screen.getByRole("status")).toHaveTextContent(
      "할 일과 결정을 찾고 있어요",
    );
    expect(
      screen.queryByRole("button", { name: "지금 찾기" }),
    ).not.toBeInTheDocument();
  });

  it("눌러서 요청이 날아가는 동안에도 진행 상태로 바뀐다 (응답 전 중복 클릭 방지)", () => {
    renderPane({ lensExtractionStatus: null, extracting: true });
    expect(screen.getByRole("status")).toHaveTextContent(
      "할 일과 결정을 찾고 있어요",
    );
  });

  it("추출이 끝난 회의는 0건이어도 렌즈 안내를 띄우지 않는다", () => {
    renderPane({ lensExtractionStatus: "done" });
    expect(
      screen.queryByText("아직 할 일과 결정을 찾지 않았어요."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "지금 찾기" }),
    ).not.toBeInTheDocument();
  });

  it("회의 처리가 끝나지 않았으면 렌즈 실행 버튼도 주지 않는다", () => {
    renderPane({
      meeting: meeting({ status: "processing" }),
      lensExtractionStatus: null,
    });
    expect(
      screen.queryByRole("button", { name: "지금 찾기" }),
    ).not.toBeInTheDocument();
  });

  it("할 일 체크박스는 서버 완료 상태로 시작하고, 누르면 반대 값으로 토글을 요청한다", () => {
    const props = renderPane({
      lenses: {
        action: [
          {
            id: "l1",
            text: "실행 로그 작성",
            source: "ai",
            ev: "utt_1",
            done: false,
          },
        ],
      },
    });
    const checkbox = screen.getByRole("checkbox", {
      name: "완료: 실행 로그 작성",
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    expect(props.onToggle).toHaveBeenCalledWith("l1", true);
  });

  it("완료된 할 일은 체크된 채로 시작하고, 누르면 열림으로 되돌리도록 요청한다", () => {
    const props = renderPane({
      lenses: {
        action: [
          {
            id: "l1",
            text: "실행 로그 작성",
            source: "ai",
            ev: "utt_1",
            done: true,
          },
        ],
      },
    });
    const checkbox = screen.getByRole("checkbox", {
      name: "완료: 실행 로그 작성",
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    expect(props.onToggle).toHaveBeenCalledWith("l1", false);
  });

  it("요약 탭에서 모델을 고르면 콜백이 불린다", async () => {
    const onSummaryModelChange = vi.fn();
    renderPane({
      tab: "summary",
      summaryModel: "mlx-community/Qwen3.5-9B-8bit",
      onSummaryModelChange,
    });
    // Radix Select는 jsdom에서 pointer 이벤트를 못 받아 mousedown으로 열리지
    // 않는다. 트리거에 포커스 후 ArrowDown(키보드)으로 열고 옵션을 클릭한다.
    const trigger = screen.getByLabelText("요약 모델");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /27B/ }));
    expect(onSummaryModelChange).toHaveBeenCalledWith(
      "mlx-community/Qwen3.5-27B-8bit",
    );
  });

  it("요약 생성 중에는 할 일 블록이 그대로 남는다", () => {
    renderPane({
      meeting: meeting({ summaryStatus: "running" }),
      lenses: {
        action: [
          {
            id: "l1",
            text: "실행 로그 작성",
            source: "ai",
            ev: "utt_1",
            done: false,
          },
        ],
      },
    });
    expect(screen.getByText("실행 로그 작성")).toBeInTheDocument();
  });
});
