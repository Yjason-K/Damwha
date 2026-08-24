import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { SpeakerTimeline } from "@/shared/ui/speaker-timeline";

/**
 * 드래그 seek 테스트 — 오버레이 레인 셀(data-slot="timeline-scrub")의 rect를
 * 목킹해 fraction 계산을 고정한다(left 0, width 100px → clientX == %).
 * jsdom에 PointerEvent가 없을 수 있어 MouseEvent 폴백으로 디스패치한다
 * (React는 이벤트 type 문자열로 핸들러를 매칭하므로 동작 동일).
 */

afterEach(cleanup);

const TRACKS = [
  { spk: 1, name: "김영재", segments: [{ start: 0, end: 0.5 }] },
  { spk: 2, name: "화자 2", segments: [{ start: 0.5, end: 1 }] },
];

function firePointer(el: Element, type: string, clientX: number) {
  const Ctor =
    (window as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  fireEvent(el, new Ctor(type, { bubbles: true, clientX }));
}

function setup() {
  const onSeek = vi.fn();
  const onScrub = vi.fn();
  const { container } = render(
    <SpeakerTimeline
      tracks={TRACKS}
      playhead={0.1}
      onSeek={onSeek}
      onScrub={onScrub}
    />,
  );
  const cell = container.querySelector('[data-slot="timeline-scrub"]')!;
  // jsdom은 pointer capture를 버전에 따라 미구현/엄격 검증하므로 스텁으로 고정.
  Object.assign(cell, { setPointerCapture: vi.fn() });
  vi.spyOn(cell, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 100,
    bottom: 16,
    width: 100,
    height: 16,
    toJSON: () => ({}),
  } as DOMRect);
  const pin = () =>
    container.querySelector('[data-slot="timeline-pin"]') as HTMLElement;
  return { container, cell, pin, onSeek, onScrub };
}

test("pointerdown은 미리보기만 갱신하고 seek하지 않는다", () => {
  const { cell, pin, onSeek, onScrub } = setup();
  firePointer(cell, "pointerdown", 25);
  expect(onScrub).toHaveBeenLastCalledWith(0.25);
  expect(onSeek).not.toHaveBeenCalled();
  expect(pin().style.left).toBe("25%");
});

test("드래그 중 pointermove가 미리보기를 따라간다", () => {
  const { cell, pin, onScrub } = setup();
  firePointer(cell, "pointerdown", 25);
  firePointer(cell, "pointermove", 50);
  expect(onScrub).toHaveBeenLastCalledWith(0.5);
  expect(pin().style.left).toBe("50%");
});

test("드래그 아닐 때 pointermove는 아무 일도 하지 않는다", () => {
  const { cell, onSeek, onScrub } = setup();
  firePointer(cell, "pointermove", 50);
  expect(onScrub).not.toHaveBeenCalled();
  expect(onSeek).not.toHaveBeenCalled();
});

test("pointerup에 onSeek 1회, 미리보기 해제 후 핀은 playhead로 복귀한다", () => {
  const { cell, pin, onSeek, onScrub } = setup();
  firePointer(cell, "pointerdown", 25);
  firePointer(cell, "pointermove", 50);
  firePointer(cell, "pointerup", 50);
  expect(onSeek).toHaveBeenCalledTimes(1);
  expect(onSeek).toHaveBeenCalledWith(0.5);
  expect(onScrub).toHaveBeenLastCalledWith(null);
  expect(pin().style.left).toBe("10%");
});

test("pointercancel은 seek 없이 미리보기만 해제한다", () => {
  const { cell, onSeek, onScrub } = setup();
  firePointer(cell, "pointerdown", 25);
  firePointer(cell, "pointercancel", 25);
  expect(onSeek).not.toHaveBeenCalled();
  expect(onScrub).toHaveBeenLastCalledWith(null);
});

test("이동 없는 down+up(클릭)도 1회 seek — 호환 click이 이어져도 중복 없다", () => {
  const { cell, onSeek } = setup();
  firePointer(cell, "pointerdown", 30);
  firePointer(cell, "pointerup", 30);
  fireEvent.click(cell, { clientX: 30 });
  expect(onSeek).toHaveBeenCalledTimes(1);
  expect(onSeek).toHaveBeenCalledWith(0.3);
});

test("범위 밖으로 끌면 0..1로 클램프된다", () => {
  const { cell, onSeek } = setup();
  firePointer(cell, "pointerdown", 50);
  firePointer(cell, "pointerup", 250);
  expect(onSeek).toHaveBeenCalledWith(1);
});

test("오버레이가 있어도 화자 재생 버튼은 클릭 가능하다", () => {
  const onPlaySpeaker = vi.fn();
  const { container, getByRole } = render(
    <SpeakerTimeline
      tracks={TRACKS}
      playhead={0.1}
      onSeek={vi.fn()}
      onPlaySpeaker={onPlaySpeaker}
    />,
  );
  // jsdom은 히트 테스트를 하지 않으므로 pointer-events 분리를 클래스로 고정:
  // 오버레이 컨테이너는 none, 레인 셀만 auto — 빈 라벨/duration 셀이
  // 아래 재생 버튼의 포인터를 가로채지 않는다.
  const cell = container.querySelector('[data-slot="timeline-scrub"]')!;
  expect(cell.classList.contains("pointer-events-auto")).toBe(true);
  expect(cell.parentElement!.classList.contains("pointer-events-none")).toBe(
    true,
  );
  fireEvent.click(getByRole("button", { name: "김영재 구간 재생" }));
  expect(onPlaySpeaker).toHaveBeenCalledTimes(1);
});

test("onSeek이 없으면 오버레이를 렌더하지 않는다", () => {
  const { container } = render(
    <SpeakerTimeline tracks={TRACKS} playhead={0.1} />,
  );
  expect(container.querySelector('[data-slot="timeline-scrub"]')).toBeNull();
});
