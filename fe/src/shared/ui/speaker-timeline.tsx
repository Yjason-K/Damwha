import * as React from "react";

import { cn } from "@/shared/lib/utils";
import { SpeakerTrack } from "@/shared/ui/speaker-track";

/**
 * SpeakerTimeline — ported from Timbre `meeting/SpeakerTimeline`. Stacks one
 * SpeakerTrack per speaker and draws a SINGLE continuous playhead pin that
 * spans every lane, anchored to the meeting time. Prefer this over giving
 * each SpeakerTrack its own `playhead` (which renders a broken-up pin per
 * attendee).
 */

type TimelineSegment = { start: number; end: number; soft?: boolean };

type TimelineTrack = {
  /** Speaker index 1–8 → lane color + avatar. */
  spk: number;
  name: React.ReactNode;
  segments?: TimelineSegment[];
  /** Mono total-talk label, e.g. "12:30". */
  duration?: React.ReactNode;
};

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
          pointer 이벤트만 쓴다. 캡처는 pointerup/cancel 후 암묵 해제(표준).
          컨테이너는 pointer-events-none — 빈 라벨/duration 셀이 아래
          화자 재생 버튼의 포인터를 가로채지 않게 레인 셀만 auto로 연다. */}
      {onSeek && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-[2] grid gap-3"
          style={{ gridTemplateColumns: cols }}
        >
          <div />
          <div
            data-slot="timeline-scrub"
            className="pointer-events-auto cursor-pointer [touch-action:none]"
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

export { SpeakerTimeline };
