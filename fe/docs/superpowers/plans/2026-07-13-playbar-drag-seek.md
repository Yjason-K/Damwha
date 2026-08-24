# 플레이바 드래그 seek Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 하단 플레이바의 화자 타임라인을 드래그해서 오디오 위치를 이동할 수 있게 한다 — 드래그 중에는 핀·시간 라벨 미리보기만, 놓는 순간 seek 1회.

**Architecture:** `SpeakerTimeline`에 레인 컬럼을 덮는 투명 드래그 오버레이(Pointer Events + 내부 `drag` state)를 추가하고, 미리보기 fraction을 선택적 `onScrub` 콜백으로 올린다. `PlayerBar`는 `scrub` state로 시간 라벨을 연동하고, `meeting.tsx`는 `<PlayerBar key={meeting.id}>` 키잉으로 회의 전환 시 드래그 상태를 초기화한다. 스펙: `docs/superpowers/specs/2026-07-13-playbar-drag-seek-design.md`.

**Tech Stack:** TypeScript (strict), React 19, Vitest (jsdom) + @testing-library/react. Node 22 + pnpm 필수 — 새 셸은 Node 20일 수 있으니 명령마다 `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null &&`를 앞에 붙인다.

## Global Constraints

- 놓을 때만 seek: `pointerup`에 `onSeek` 정확히 1회. 드래그 중 `currentTime` 변경 금지.
- 오버레이는 pointer 이벤트만 사용 — `onClick` 금지 (호환 click 중복 방지).
- 오버레이 접근성: `aria-hidden="true"`, role 없음, 포커스 불가.
- `releasePointerCapture` 호출 금지 — 암묵 해제가 표준 (스펙의 의도적 배제).
- `drag`/`scrub`은 `0`도 유효값 — 판별은 `??`/`== null`로만, falsy 검사 금지.
- `SpeakerTrack`은 수정하지 않는다 (API·클릭 seek 유지).
- 테스트 셀렉터는 `data-slot` 속성 (리포 관행).
- 커밋 메시지·주석·UI 문자열은 한국어. 마무리 전 `pnpm format` (단, 이 작업 파일 외 무관 파일이 재포맷되면 커밋에서 제외).

---

### Task 1: SpeakerTimeline 드래그 오버레이

**Files:**
- Modify: `src/shared/ui/speaker-timeline.tsx` (전체 구조 변경 — 아래 코드로)
- Create(Test): `src/shared/ui/speaker-timeline.test.tsx`

**Interfaces:**
- Consumes: 기존 `SpeakerTimeline` props (`tracks`, `playhead`, `labelWidth`, `gap`, `onSeek`, `onPlaySpeaker`).
- Produces: 새 optional prop `onScrub?: (fraction: number | null) => void` — 드래그 중 미리보기 fraction(0–1), 종료/취소 시 `null`. Task 2의 `PlayerBar`가 사용한다. DOM 계약: 오버레이 레인 셀 `data-slot="timeline-scrub"`, 핀 `data-slot="timeline-pin"`.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/shared/ui/speaker-timeline.test.tsx` 생성 (리포 규약: vitest globals 없음, 수동 cleanup):

```tsx
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

test("onSeek이 없으면 오버레이를 렌더하지 않는다", () => {
  const { container } = render(
    <SpeakerTimeline tracks={TRACKS} playhead={0.1} />,
  );
  expect(container.querySelector('[data-slot="timeline-scrub"]')).toBeNull();
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm vitest run src/shared/ui/speaker-timeline.test.tsx`
Expected: FAIL — `data-slot="timeline-scrub"` 요소가 없어 `cell`이 null (`setup`에서 TypeError) 또는 셀렉터 단언 실패. "onSeek이 없으면 오버레이를 렌더하지 않는다"만 PASS일 수 있음.

- [ ] **Step 3: SpeakerTimeline 구현**

`src/shared/ui/speaker-timeline.tsx`에서 props 타입에 `onScrub`을 추가하고 함수 본문을 아래로 교체한다. 바뀌는 것: `drag` state + `fractionAt` + 드래그 오버레이 추가, 핀 위치 `drag ?? playhead`, 트랙으로의 `onSeek` 전달 제거, 핀에 `data-slot="timeline-pin"`. 파일 상단 주석과 타입 선언(`TimelineSegment`, `TimelineTrack`)은 그대로.

```tsx
type SpeakerTimelineProps = Omit<React.ComponentProps<"div">, "onSeek"> & {
  /** One entry per speaker lane, top → bottom. */
  tracks?: TimelineTrack[];
  /** Shared playhead position (0–1) → single spanning accent pin. */
  playhead?: number;
  /** Width of the label column in px. */
  labelWidth?: number;
  /** Vertical gap between lanes in px. */
  gap?: number;
  /** 드래그/클릭 seek — pointerup(놓는 순간)에 0–1 fraction으로 1회 호출. */
  onSeek?: (fraction: number) => void;
  /** 드래그 미리보기 fraction(0–1). 드래그 종료/취소 시 null. */
  onScrub?: (fraction: number | null) => void;
  /** Per-lane play button handler; receives the track. */
  onPlaySpeaker?: (track: TimelineTrack) => void;
};

function SpeakerTimeline({
  className,
  tracks = [],
  playhead,
  labelWidth = 112,
  gap = 3,
  onSeek,
  onScrub,
  onPlaySpeaker,
  style,
  ...rest
}: SpeakerTimelineProps) {
  // 드래그 미리보기 fraction — null이면 드래그 중 아님. 0도 유효값이므로
  // 판별은 ??/== null로만 한다.
  const [drag, setDrag] = React.useState<number | null>(null);
  const hasDuration = tracks.some((t) => t.duration != null);
  const cols = hasDuration ? `${labelWidth}px 1fr 44px` : `${labelWidth}px 1fr`;
  const pin = drag ?? playhead;

  const fractionAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };

  return (
    <div className={cn("relative", className)} style={style} {...rest}>
      <div className="flex flex-col" style={{ gap }}>
        {tracks.map((t) => (
          <SpeakerTrack
            key={t.spk}
            speaker={t.spk}
            name={t.name}
            segments={t.segments}
            duration={t.duration}
            showPlayhead={false}
            labelWidth={labelWidth}
            onPlaySpeaker={onPlaySpeaker ? () => onPlaySpeaker(t) : undefined}
          />
        ))}
      </div>

      {/* 드래그/클릭 seek 오버레이 — 레인 컬럼 전체를 덮는다. 누른 지점부터
          미리보기(핀·onScrub), 놓는 순간 onSeek 1회. 호환 click 중복을 피해
          pointer 이벤트만 쓴다. 캡처는 pointerup/cancel 후 암묵 해제(표준). */}
      {onSeek && (
        <div
          aria-hidden="true"
          className="absolute inset-0 z-[2] grid gap-3"
          style={{ gridTemplateColumns: cols }}
        >
          <div />
          <div
            data-slot="timeline-scrub"
            className="cursor-pointer [touch-action:none]"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture?.(e.pointerId);
              const f = fractionAt(e);
              setDrag(f);
              onScrub?.(f);
            }}
            onPointerMove={(e) => {
              if (drag == null) return;
              const f = fractionAt(e);
              setDrag(f);
              onScrub?.(f);
            }}
            onPointerUp={(e) => {
              if (drag == null) return;
              onSeek(fractionAt(e));
              setDrag(null);
              onScrub?.(null);
            }}
            onPointerCancel={() => {
              setDrag(null);
              onScrub?.(null);
            }}
          />
          {hasDuration && <div />}
        </div>
      )}

      {/* Single continuous time pin — aligned to the lane column via a grid
          matching SpeakerTrack's columns (label | lane | duration, gap 12).
          드래그 중에는 미리보기(drag)를 따른다. */}
      {pin != null && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-[3] grid gap-3"
          style={{ gridTemplateColumns: cols }}
        >
          <div />
          <div className="relative">
            <div
              data-slot="timeline-pin"
              className="absolute -top-[3px] -bottom-[3px] w-0.5 -translate-x-px rounded-[1px] bg-[var(--accent-solid)]"
              style={{ left: `${Math.max(0, Math.min(1, pin)) * 100}%` }}
            >
              <span className="absolute -top-[3px] -left-0.5 size-1.5 rounded-full bg-[var(--accent-solid)]" />
            </div>
          </div>
          {hasDuration && <div />}
        </div>
      )}
    </div>
  );
}
```

주의: `SpeakerTimelineProps`의 기존 `onSeek` JSDoc("Click-to-seek on any lane")은 위처럼 새 의미로 갱신한다. `SpeakerTrack` 파일은 열지 않는다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm vitest run src/shared/ui/speaker-timeline.test.tsx`
Expected: 8건 전부 PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/shared/ui/speaker-timeline.tsx src/shared/ui/speaker-timeline.test.tsx
git commit -m "feat: 타임라인 드래그 seek — 놓을 때 1회 seek + 미리보기 핀/onScrub"
```

---

### Task 2: PlayerBar 시간 라벨 연동 + 회의 전환 초기화

**Files:**
- Modify: `src/features/meeting/ui/player-bar.tsx` (import 추가, scrub state, 라벨, onScrub 연결)
- Modify: `src/pages/meeting.tsx:457-471` (`<PlayerBar>`에 `key={meeting.id}` 추가)
- Create(Test): `src/features/meeting/ui/player-bar.test.tsx`

**Interfaces:**
- Consumes: Task 1의 `SpeakerTimeline` prop `onScrub?: (fraction: number | null) => void`와 DOM 계약(`data-slot="timeline-scrub"`).
- Produces: 없음 (동작 변경만 — `PlayerBar` 외부 props 불변).

- [ ] **Step 1: 실패하는 테스트 작성**

`src/features/meeting/ui/player-bar.test.tsx` 생성:

```tsx
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
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm vitest run src/features/meeting/ui/player-bar.test.tsx`
Expected: FAIL — pointerdown 후에도 라벨이 `01:00` 그대로라 `getByText("05:00")`가 요소를 못 찾음.

- [ ] **Step 3: PlayerBar 구현**

`src/features/meeting/ui/player-bar.tsx`:

파일 맨 위에 import 추가:

```tsx
import * as React from "react";
```

`PlayerBar` 함수 본문 시작(`const step = ...` 앞)에 state 추가:

```tsx
  // 드래그 미리보기 시각 — SpeakerTimeline 드래그 중에만 non-null.
  const [scrub, setScrub] = React.useState<number | null>(null);
```

시간 라벨(기존 `{fmt(pos, totalSeconds)}{" "}`)을 교체:

```tsx
          {fmt(scrub ?? pos, totalSeconds)}{" "}
```

`<SpeakerTimeline>`에 `onScrub` 연결 (기존 `onSeek={onSeek}` 아래):

```tsx
          onSeek={onSeek}
          onScrub={setScrub}
```

- [ ] **Step 4: meeting.tsx 키잉**

`src/pages/meeting.tsx`의 `<PlayerBar` 여는 태그에 `key={meeting.id}` 추가:

```tsx
        <PlayerBar
          key={meeting.id}
          tracks={meeting.tracks}
```

이유(스펙): 드래그 중 ⌘K 등 키보드로 회의가 전환되면 리마운트로 `scrub`·`drag`가 함께 초기화되어 stale 미리보기가 남지 않는다 — `<audio key={meeting.id}>`와 같은 패턴.

- [ ] **Step 5: 테스트 통과 및 전체 검증**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm vitest run src/features/meeting/ui/player-bar.test.tsx`
Expected: PASS.

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm build && pnpm lint && pnpm test && pnpm format`
Expected: `tsc -b` 에러 없음, eslint 통과, 전체 테스트(기존 40 + 새 9 = 49건) PASS. `pnpm format`이 이 작업 파일 외 무관 파일을 재포맷하면 그 파일들은 `git checkout --`으로 되돌린다.

- [ ] **Step 6: 커밋**

```bash
git add src/features/meeting/ui/player-bar.tsx src/features/meeting/ui/player-bar.test.tsx src/pages/meeting.tsx
git commit -m "feat: 플레이바 드래그 중 시간 라벨 미리보기 + 회의 전환 시 드래그 상태 초기화"
```
