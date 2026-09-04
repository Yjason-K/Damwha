import * as React from "react";

import { cn } from "@/shared/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { SpeakerTimeline } from "@/shared/ui/speaker-timeline";

import type { SpeakerLane } from "../model/data";
import { Icon } from "./icons";

/**
 * PlayerBar — full-width bottom bar: transport + time (aligned under the
 * nav rail), time ruler + speaker lanes, speed select. Ported from
 * `timbre_app/PlayerBar.jsx`.
 *
 * 이전/다음 발언은 콜백이 null이면(이동할 발언 없음) 비활성, undefined면
 * (호출자가 발언 이동을 지원하지 않음) 역시 비활성으로 그린다.
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

function Skip({
  dir,
  onClick,
}: {
  dir: "prev" | "next";
  onClick: (() => void) | null | undefined;
}) {
  return (
    <button
      type="button"
      onClick={onClick ?? undefined}
      disabled={!onClick}
      aria-label={dir === "prev" ? "이전 발언" : "다음 발언"}
      className="inline-flex size-8 cursor-pointer items-center justify-center rounded-sm text-[color:var(--text-secondary)] outline-none transition-colors hover:text-foreground focus-visible:[box-shadow:var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-[color:var(--text-secondary)]"
    >
      <Icon name={dir === "prev" ? "skipBack" : "skipForward"} size={18} />
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
  /** null = 이동할 발언 없음(비활성). */
  onPrevUtterance?: (() => void) | null;
  onNextUtterance?: (() => void) | null;
  className?: string;
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
  onPrevUtterance,
  onNextUtterance,
  className,
}: PlayerBarProps) {
  // 드래그 미리보기 시각 — SpeakerTimeline 드래그 중에만 non-null.
  const [scrub, setScrub] = React.useState<number | null>(null);
  const step = 10 / totalSeconds;

  return (
    // 랜드마크가 아니라 셸의 트랜스포트 줄 — footer(contentinfo)로 두면 오분류
    <div
      data-tour="player-bar"
      className={cn(
        "flex shrink-0 items-center border-t border-border bg-[var(--surface-card)] px-5 pt-2.5 pb-3",
        className,
      )}
    >
      {/* transport (rail-aligned) */}
      <div className="flex w-[calc(var(--rail-nav)-20px)] shrink-0 flex-col items-center gap-[3px]">
        <div className="flex items-center gap-1">
          <Skip dir="prev" onClick={onPrevUtterance} />
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
          <Skip dir="next" onClick={onNextUtterance} />
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
      <div className="flex shrink-0 items-center pl-2">
        <Select value={String(speed)} onValueChange={(v) => onSpeed(Number(v))}>
          <SelectTrigger size="sm" className="w-[76px]" aria-label="재생 속도">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SPEEDS.map((s) => (
              <SelectItem key={s} value={String(s)}>
                {s}x
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
