import * as React from "react";

import { IconButton } from "@/shared/ui/icon-button";
import { SpeakerTimeline } from "@/shared/ui/speaker-timeline";

import type { SpeakerLane } from "../model/data";
import { Icon } from "./icons";

/**
 * PlayerBar — full-width bottom bar: transport + time (aligned under the
 * nav rail), time ruler + speaker lanes, speed + view controls. Ported from
 * `timbre_app/PlayerBar.jsx`.
 */

const LABEL_W = 112;
const SPEEDS = [1, 1.2, 1.5, 2] as const;

function fmt(fraction: number, totalSeconds: number) {
  const s = Math.round(fraction * totalSeconds);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function Replay({
  dir,
  onClick,
}: {
  dir: "back" | "fwd";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={dir === "back" ? "10초 뒤로" : "10초 앞으로"}
      className="relative inline-flex size-8 cursor-pointer items-center justify-center rounded-sm text-[color:var(--text-secondary)] outline-none transition-colors hover:text-foreground focus-visible:[box-shadow:var(--focus-ring)]"
    >
      <Icon
        name={dir === "back" ? "rotateCcw" : "rotateCw"}
        size={22}
        strokeWidth={1.7}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-[52%] right-0 left-0 -translate-y-1/2 text-center font-mono text-[8px] font-bold"
      >
        10
      </span>
    </button>
  );
}

function Ruler({ totalSeconds }: { totalSeconds: number }) {
  const marks: number[] = [];
  for (let m = 0; m * 600 <= totalSeconds; m += 1) marks.push(m * 10);
  return (
    <div
      aria-hidden="true"
      className="relative h-4"
      style={{ marginLeft: LABEL_W + 12 }}
    >
      {marks.map((m) => (
        <span
          key={m}
          className="absolute font-mono text-[10px] text-[color:var(--text-faint)]"
          style={{
            left: `${((m * 60) / totalSeconds) * 100}%`,
            transform: m === 0 ? "none" : "translateX(-50%)",
          }}
        >
          {String(m).padStart(2, "0")}:00
        </span>
      ))}
    </div>
  );
}

type PlayerBarProps = {
  tracks: SpeakerLane[];
  playing: boolean;
  pos: number;
  totalSeconds: number;
  durLabel: string;
  speed: number;
  onSpeed: (speed: number) => void;
  onToggle: () => void;
  onSeek: (fraction: number) => void;
};

export function PlayerBar({
  tracks,
  playing,
  pos,
  totalSeconds,
  durLabel,
  speed,
  onSpeed,
  onToggle,
  onSeek,
}: PlayerBarProps) {
  // 드래그 미리보기 시각 — SpeakerTimeline 드래그 중에만 non-null.
  const [scrub, setScrub] = React.useState<number | null>(null);
  const step = 10 / totalSeconds;
  const cycleSpeed = () => {
    const i = SPEEDS.indexOf(speed as (typeof SPEEDS)[number]);
    onSpeed(SPEEDS[(i + 1) % SPEEDS.length]);
  };

  return (
    // 랜드마크가 아니라 셸의 트랜스포트 줄 — footer(contentinfo)로 두면 오분류
    <div className="flex shrink-0 items-center border-t border-border bg-[var(--surface-card)] px-5 pt-2.5 pb-3">
      {/* transport (rail-aligned) */}
      <div className="flex w-[calc(var(--rail-nav)-20px)] shrink-0 flex-col items-center gap-[3px]">
        <div className="flex items-center gap-2">
          <Replay dir="back" onClick={() => onSeek(Math.max(0, pos - step))} />
          <button
            type="button"
            onClick={onToggle}
            aria-label={playing ? "일시정지" : "재생"}
            className="inline-flex size-10 cursor-pointer items-center justify-center rounded-full bg-[var(--accent-solid)] text-white outline-none transition-colors hover:bg-[var(--accent-solid-hover)] focus-visible:[box-shadow:var(--focus-ring)] [box-shadow:var(--shadow-sm)]"
          >
            <Icon
              name={playing ? "pause" : "play"}
              size={17}
              strokeWidth={2}
              className={playing ? undefined : "ml-0.5"}
            />
          </button>
          <Replay dir="fwd" onClick={() => onSeek(Math.min(1, pos + step))} />
        </div>
        <div className="font-mono text-xs tracking-[-0.01em] text-[color:var(--text-secondary)]">
          {fmt(scrub ?? pos, totalSeconds)}{" "}
          <span className="text-[color:var(--text-faint)]">/ {durLabel}</span>
        </div>
      </div>

      {/* timeline */}
      <div className="min-w-0 flex-1 px-4">
        <Ruler totalSeconds={totalSeconds} />
        <SpeakerTimeline
          tracks={tracks.map((t) => ({
            spk: t.spk,
            name: t.name,
            segments: t.segments,
          }))}
          playhead={pos}
          labelWidth={LABEL_W}
          onSeek={onSeek}
          onScrub={setScrub}
        />
      </div>

      {/* right controls */}
      <div className="flex shrink-0 flex-col items-end gap-2 pl-2">
        <button
          type="button"
          onClick={cycleSpeed}
          aria-label={`재생 속도 (현재 ${speed}x)`}
          className="inline-flex cursor-pointer items-center gap-1 rounded-sm border border-border bg-[var(--gray-0)] px-2 py-1 text-xs font-medium text-[color:var(--text-secondary)] outline-none transition-colors hover:border-[color:var(--border-strong)] hover:text-foreground focus-visible:[box-shadow:var(--focus-ring)]"
        >
          {speed}x <Icon name="chevDown" size={13} />
        </button>
        <div className="flex gap-0.5">
          <IconButton label="파형" size="sm">
            <Icon name="waveform" size={16} />
          </IconButton>
          <IconButton label="전체화면" size="sm">
            <Icon name="expand" size={16} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
