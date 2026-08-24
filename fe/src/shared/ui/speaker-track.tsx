import * as React from "react";

import { cn } from "@/shared/lib/utils";

/**
 * SpeakerTrack — ported from Timbre `meeting/SpeakerTrack`. One speaker's
 * lane across the meeting timeline. `segments` are {start,end} fractions
 * (0–1); `playhead` is a 0–1 fraction. Play button is keyboard-accessible;
 * clicking the lane seeks (mouse).
 */

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M5 3.5v9l7-4.5z" />
    </svg>
  );
}

type Segment = { start: number; end: number; soft?: boolean };

type SpeakerTrackProps = Omit<React.ComponentProps<"div">, "onSeek"> & {
  speaker?: number;
  name?: React.ReactNode;
  segments?: Segment[];
  duration?: React.ReactNode;
  playhead?: number;
  /** Draw this track's own playhead. Turn off when a parent renders a single
   *  playhead across stacked tracks (e.g. a multi-speaker player bar). */
  showPlayhead?: boolean;
  labelWidth?: number;
  onSeek?: (fraction: number) => void;
  onPlaySpeaker?: () => void;
};

function SpeakerTrack({
  className,
  speaker = 1,
  name,
  segments = [],
  duration,
  playhead,
  showPlayhead = true,
  labelWidth = 112,
  onSeek,
  onPlaySpeaker,
  style,
  ...rest
}: SpeakerTrackProps) {
  const k = ((Number(speaker) - 1) % 8) + 1;
  const cols =
    duration != null ? `${labelWidth}px 1fr 44px` : `${labelWidth}px 1fr`;
  const handleSeek: React.MouseEventHandler<HTMLDivElement> = (e) => {
    if (!onSeek) return;
    const r = e.currentTarget.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
  };

  return (
    <div
      className={cn("grid items-center gap-3 py-1", className)}
      style={
        {
          "--_solid": `var(--spk-${k}-solid)`,
          gridTemplateColumns: cols,
          ...style,
        } as React.CSSProperties
      }
      {...rest}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          aria-label={`${typeof name === "string" ? name : "화자"} 구간 재생`}
          onClick={onPlaySpeaker}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--_solid)] text-white outline-none transition-transform duration-[80ms] hover:scale-110 focus-visible:[box-shadow:var(--focus-ring)] [&_svg]:ml-px [&_svg]:size-[9px]"
        >
          <PlayIcon />
        </button>
        <span className="truncate text-sm font-medium text-foreground">
          {name}
        </span>
      </div>
      <div
        className="relative h-4 cursor-pointer overflow-visible rounded-xs bg-[var(--gray-2)]"
        onClick={handleSeek}
      >
        {segments.map((seg, i) => (
          <div
            key={i}
            className="absolute top-0 bottom-0 rounded-[3px] bg-[var(--_solid)]"
            style={{
              left: `${seg.start * 100}%`,
              width: `${(seg.end - seg.start) * 100}%`,
              opacity: seg.soft ? 0.5 : 0.92,
            }}
          />
        ))}
        {showPlayhead && playhead != null && (
          <div
            className="absolute -top-1 -bottom-1 z-[2] w-0.5 rounded-[1px] bg-[var(--accent-solid)] before:absolute before:-top-[3px] before:-left-[2px] before:size-1.5 before:rounded-full before:bg-[var(--accent-solid)] before:content-['']"
            style={{ left: `${playhead * 100}%` }}
          />
        )}
      </div>
      {duration != null && (
        <span className="text-right font-mono text-2xs tracking-[var(--tracking-mono)] text-[color:var(--text-faint)]">
          {duration}
        </span>
      )}
    </div>
  );
}

export { SpeakerTrack };
