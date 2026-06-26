import * as React from "react";

import { cn } from "@/shared/lib/utils";
import { Checkbox } from "@/shared/ui/checkbox";

/**
 * LensItem — ported from Timbre `meeting/LensItem`. An insight / action-item
 * card: optional checkbox (reuses the accessible Checkbox), text (struck
 * through when done), and a meta row with source badge, assignee chip
 * (speaker-tinted), and an evidence "jump to source" link.
 */

function JumpIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3.5h6.5V10" />
      <path d="M12.5 3.5L4 12" />
    </svg>
  );
}

type LensSource = "ai" | "user" | "edited" | "hint";

const SRC_LABEL: Record<LensSource, string> = {
  ai: "AI 추출",
  user: "직접 추가",
  edited: "수정됨",
  hint: "확인 필요",
};

const SRC_CLASS: Record<LensSource, string> = {
  ai: "bg-[var(--accent-2)] text-[color:var(--accent-text)]",
  user: "border border-border bg-[var(--gray-2)] text-[color:var(--text-secondary)]",
  edited: "bg-[var(--gray-2)] text-[color:var(--text-secondary)]",
  hint: "bg-[var(--amber-bg)] text-[color:var(--amber-text)]",
};

type LensItemProps = Omit<React.ComponentProps<"div">, "children"> & {
  children?: React.ReactNode;
  source?: LensSource;
  checkable?: boolean;
  done?: boolean;
  onToggle?: () => void;
  assignee?: React.ReactNode;
  assigneeSpeaker?: number;
  evidence?: React.ReactNode;
  onJump?: () => void;
};

function LensItem({
  className,
  children,
  source = "ai",
  checkable = false,
  done = false,
  onToggle,
  assignee,
  assigneeSpeaker,
  evidence,
  onJump,
  ...rest
}: LensItemProps) {
  const k =
    assigneeSpeaker != null ? ((Number(assigneeSpeaker) - 1) % 8) + 1 : null;
  const whoStyle = k
    ? ({
        "--_wt": `var(--spk-${k}-text)`,
        "--_wbg": `var(--spk-${k}-bg)`,
        "--_wd": `var(--spk-${k}-solid)`,
      } as React.CSSProperties)
    : undefined;

  return (
    <div
      className={cn(
        "flex gap-2.5 rounded-sm border border-[color:var(--border-subtle)] bg-card px-3 py-[11px] transition-[border-color] duration-[80ms] hover:border-border",
        className,
      )}
      {...rest}
    >
      {checkable && (
        <span className="mt-px">
          <Checkbox
            aria-label="완료"
            checked={done}
            onChange={onToggle ? () => onToggle() : undefined}
          />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-[7px]">
        <div
          className={cn(
            "text-base leading-normal text-pretty text-foreground",
            done &&
              "text-[color:var(--text-muted)] line-through decoration-[color:var(--border-strong)]",
          )}
        >
          {children}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5 text-2xs font-medium",
              SRC_CLASS[source],
            )}
          >
            {SRC_LABEL[source] ?? source}
          </span>
          {assignee && (
            <span
              className="inline-flex items-center gap-[5px] rounded-xs bg-[var(--_wbg,var(--gray-2))] px-1.5 py-0.5 text-2xs font-medium text-[color:var(--_wt,var(--text-secondary))]"
              style={whoStyle}
            >
              {k && <span className="size-1.5 rounded-full bg-[var(--_wd,currentColor)]" />}
              {assignee}
            </span>
          )}
          {evidence ? (
            <button
              type="button"
              onClick={onJump}
              className="inline-flex items-center gap-1 rounded-xs px-1 py-0.5 text-2xs font-medium text-[color:var(--text-link)] outline-none transition-colors hover:bg-[var(--accent-1)] focus-visible:[box-shadow:var(--focus-ring)] [&_svg]:size-[11px]"
            >
              <JumpIcon />
              <span>원문 보기</span>
              <span className="font-mono tracking-[var(--tracking-mono)]">
                {evidence}
              </span>
            </button>
          ) : (
            <span className="inline-flex items-center px-1 py-0.5 text-2xs font-medium text-[color:var(--text-faint)]">
              증거 없음
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export { LensItem };
