import * as React from "react";

import { cn } from "@/shared/lib/utils";

/**
 * Utterance — ported from Timbre `meeting/Utterance`. A transcript line:
 * timestamp · speaker pill · reading-size text. Supports `active`, a
 * `quoted` saved-card variant, and hover/focus jump + bookmark actions.
 */

function MicIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="6" y="2.5" width="4" height="7" rx="2" />
      <path d="M4.5 8a3.5 3.5 0 0 0 7 0M8 11.5v2" />
    </svg>
  );
}

function JumpIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3.5h6.5V10" />
      <path d="M12.5 3.5L4 12" />
    </svg>
  );
}

function QuoteIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M3 9.5C3 6.5 5 4.5 7.5 4l.4 1.3C6.4 5.8 5.5 6.7 5.4 8H7v3.5H3zM9 9.5C9 6.5 11 4.5 13.5 4l.4 1.3c-1.5.5-2.4 1.4-2.5 2.7H13v3.5H9z" />
    </svg>
  );
}

function BookmarkIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M4 3.5A1.5 1.5 0 0 1 5.5 2h5A1.5 1.5 0 0 1 12 3.5V14l-4-2.6L4 14z" />
    </svg>
  );
}

function pillVars(speaker?: number): React.CSSProperties {
  if (speaker == null) {
    return {
      "--_bg": "var(--gray-2)",
      "--_text": "var(--text-secondary)",
      "--_solid": "var(--gray-7)",
    } as React.CSSProperties;
  }
  const k = ((Number(speaker) - 1) % 8) + 1;
  return {
    "--_bg": `var(--spk-${k}-bg)`,
    "--_text": `var(--spk-${k}-text)`,
    "--_solid": `var(--spk-${k}-solid)`,
  } as React.CSSProperties;
}

function SpeakerPill({
  speaker,
  name,
}: {
  speaker?: number;
  name?: React.ReactNode;
}) {
  return (
    <span
      className="relative -top-px mr-2 inline-flex select-none items-center gap-[5px] rounded-full bg-[var(--_bg)] py-0.5 pr-[9px] pl-[3px] align-middle text-sm font-semibold whitespace-nowrap text-[color:var(--_text)]"
      style={pillVars(speaker)}
    >
      <span className="inline-flex size-[17px] items-center justify-center rounded-full bg-[var(--_solid)] text-white [&_svg]:size-2.5">
        <MicIcon />
      </span>
      {name}
    </span>
  );
}

type UtteranceProps = Omit<React.ComponentProps<"div">, "children"> & {
  speaker?: number;
  name?: React.ReactNode;
  time?: React.ReactNode;
  active?: boolean;
  quoted?: boolean;
  placeholder?: boolean;
  badge?: React.ReactNode;
  onJump?: () => void;
  saved?: boolean;
  onSaveToggle?: () => void;
  savePending?: boolean;
  onBookmark?: () => void;
  children?: React.ReactNode;
};

function Utterance({
  className,
  speaker,
  name,
  time,
  active = false,
  quoted = false,
  placeholder = false,
  badge = "인용",
  onJump,
  saved = false,
  onSaveToggle,
  savePending = false,
  onBookmark,
  children,
  ...rest
}: UtteranceProps) {
  const root = cn(
    "group/utt relative grid grid-cols-[52px_1fr] gap-3 rounded-sm py-[7px] pr-3 pl-1.5 transition-colors duration-[80ms]",
    active
      ? "bg-[var(--accent-1)] [box-shadow:inset_2px_0_0_var(--accent-solid)]"
      : "hover:bg-[var(--gray-1)]",
    className,
  );
  const timeEl = (
    <span className="pt-1 text-right font-mono text-xs tracking-[var(--tracking-mono)] whitespace-nowrap text-[color:var(--text-faint)]">
      {time}
    </span>
  );

  if (quoted) {
    return (
      <div className={root} {...rest}>
        {timeEl}
        <div className="flex items-start gap-2.5 rounded-md border border-border bg-card px-3 py-[11px] [box-shadow:var(--shadow-xs)]">
          <span className="mt-px shrink-0 text-[color:var(--gray-5)] [&_svg]:size-4">
            <QuoteIcon />
          </span>
          <div className="min-w-0 flex-1">
            <SpeakerPill speaker={speaker} name={name} />
            <span className="text-read text-pretty text-foreground">
              {children}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {badge && (
              <span className="inline-flex items-center rounded-xs border border-border bg-[var(--gray-2)] px-[7px] py-0.5 text-2xs font-medium text-[color:var(--text-muted)]">
                {badge}
              </span>
            )}
            <button
              type="button"
              aria-label="저장"
              onClick={onBookmark}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-xs text-[color:var(--accent-text)] outline-none hover:bg-[var(--accent-1)] focus-visible:[box-shadow:var(--focus-ring)] [&_svg]:size-[15px]"
            >
              <BookmarkIcon />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={root} {...rest}>
      {timeEl}
      <div className="min-w-0">
        {/* 활성 블록은 원문 보기 버튼(absolute)이 항상 떠 있으므로 첫 줄에 자리 확보 */}
        {onJump && active && (
          <span aria-hidden className="float-right h-6 w-[120px]" />
        )}
        <SpeakerPill speaker={speaker} name={name} />
        <span
          className={cn(
            "text-read text-pretty",
            placeholder
              ? "italic text-[color:var(--text-muted)]"
              : "text-foreground",
          )}
        >
          {children}
        </span>
      </div>
      {onJump && (
        <div className={cn("absolute top-1.5 right-2 flex items-center gap-1 transition-opacity duration-[120ms] focus-within:opacity-100 group-hover/utt:opacity-100", active ? "opacity-100" : "opacity-0")}>
          <button type="button" aria-label={saved ? "저장 해제" : "발언 저장"} onClick={onSaveToggle} disabled={savePending} className="inline-flex size-6 items-center justify-center rounded-xs border border-border bg-card text-[color:var(--accent-text)] outline-none hover:border-[color:var(--accent-6)] hover:bg-[var(--accent-1)] disabled:cursor-wait disabled:opacity-60 focus-visible:[box-shadow:var(--focus-ring)] [&_svg]:size-[14px]">
            <BookmarkIcon />
          </button>
          <button type="button" onClick={onJump} className="inline-flex items-center gap-[5px] rounded-xs border border-border bg-card px-[7px] py-[3px] text-xs font-medium text-[color:var(--text-link)] outline-none hover:border-[color:var(--accent-6)] hover:bg-[var(--accent-1)] focus-visible:[box-shadow:var(--focus-ring)] [&_svg]:size-3">
            <JumpIcon />
            <span>원문 보기</span>
          </button>
        </div>
      )}
    </div>
  );
}

export { Utterance };
