import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { PlayerBar } from "@/features/meeting/ui/player-bar";

/** 드래그 중 시간 라벨이 미리보기 시각을 따라가고, 놓으면 pos로 복귀한다. */

afterEach(cleanup);

const TRACKS = [
  { spk: 1, name: "김영재", dur: "01:00", segments: [{ start: 0, end: 0.5 }] },
];

function firePointer(el: Element, type: string, clientX: number) {
  const Ctor =
    (window as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  fireEvent(el, new Ctor(type, { bubbles: true, clientX }));
}

test("드래그 중 시간 라벨이 미리보기를 따라가고 놓으면 복귀한다", () => {
  const onSeek = vi.fn();
  const { container } = render(
    <PlayerBar
      tracks={TRACKS}
      playing={false}
      pos={0.1}
      totalSeconds={600}
      durLabel="10:00"
      speed={1}
      onSpeed={() => {}}
      onToggle={() => {}}
      onSeek={onSeek}
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

  // pos 0.1 × 600s = 60s → 01:00
  expect(screen.getByText("01:00")).toBeTruthy();

  // 50% 지점 드래그 미리보기 → 300s = 05:00
  firePointer(cell, "pointerdown", 50);
  expect(screen.getByText("05:00")).toBeTruthy();

  // 놓으면 onSeek(0.5) 1회, 라벨은 pos(01:00)로 복귀.
  firePointer(cell, "pointerup", 50);
  expect(onSeek).toHaveBeenCalledTimes(1);
  expect(onSeek).toHaveBeenCalledWith(0.5);
  expect(screen.getByText("01:00")).toBeTruthy();
});

test("className이 루트에 병합되고 기존 클래스도 유지된다", () => {
  const { container } = render(
    <PlayerBar
      tracks={TRACKS}
      playing={false}
      pos={0}
      totalSeconds={600}
      durLabel="10:00"
      speed={1}
      onSpeed={() => {}}
      onToggle={() => {}}
      onSeek={() => {}}
      className="col-span-2"
    />,
  );
  const root = container.firstElementChild!;
  expect(root).toHaveClass("col-span-2");
  expect(root).toHaveClass("border-t");
});
