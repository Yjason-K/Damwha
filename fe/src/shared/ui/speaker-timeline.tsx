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
  /** Click-to-seek on any lane; receives the clicked 0–1 fraction. */
  onSeek?: (fraction: number) => void;
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
  onPlaySpeaker,
  style,
  ...rest
}: SpeakerTimelineProps) {
  const hasDuration = tracks.some((t) => t.duration != null);
  const cols = hasDuration ? `${labelWidth}px 1fr 44px` : `${labelWidth}px 1fr`;

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
            onSeek={onSeek}
            onPlaySpeaker={onPlaySpeaker ? () => onPlaySpeaker(t) : undefined}
          />
        ))}
      </div>

      {/* Single continuous time pin — aligned to the lane column via a grid
          matching SpeakerTrack's columns (label | lane | duration, gap 12). */}
      {playhead != null && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-[3] grid gap-3"
          style={{ gridTemplateColumns: cols }}
        >
          <div />
          <div className="relative">
            <div
              className="absolute -top-[3px] -bottom-[3px] w-0.5 -translate-x-px rounded-[1px] bg-[var(--accent-solid)]"
              style={{
                left: `${Math.max(0, Math.min(1, playhead)) * 100}%`,
              }}
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
