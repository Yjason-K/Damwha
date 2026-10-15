import * as React from "react";
import { Link } from "react-router";

import { cn } from "@/shared/lib/utils";

/**
 * Utterance — ported from Timbre `meeting/Utterance`. A transcript line:
 * timestamp · speaker pill · reading-size text. Supports `active`, a
 * `quoted` saved-card variant, and hover/focus jump + bookmark actions.
 *
 * `to`는 발언이 지금 있는 화면 밖을 가리킬 때(저장한 발언 목록 등) 준다. 행
 * 전체가 그 경로로 가는 링크가 되므로 "회의에서 보기"는 버튼이 아니라 힌트가 된다 —
 * 같은 목적지로 가는 조작이 둘일 이유가 없고, 링크 안의 버튼은 중첩이라 못 쓴다.
 *
 * `onJump`만 주면(회의 화면) 타임스탬프가 버튼이 되고, 행 어디를 눌러도(본문·화자·여백)
 * 그 시점으로 간다. 본문 글자만 클릭 대상이던 판에서는 화자 필·줄 끝 여백을 누른 클릭이
 * 아무 일도 하지 않아 "본문을 눌러도 00:00에 머문다"는 보고가 나왔다(2026-10).
 * 텍스트를 고르려는 조작은 건너뛴다 — 드래그(포인터가 움직임), 더블·트리플 클릭(단어·
 * 문단 선택), 이 행 안에 선택이 남아 있는 경우. 행 안의 버튼·링크는 제 할 일만 한다.
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

const JUMP_CHIP =
  "inline-flex items-center gap-[5px] rounded-xs border border-border bg-card px-[7px] py-[3px] text-xs font-medium [&_svg]:size-3";

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
  /** 사용자가 점프/선택한 발언 — 배경 틴트 + 액션 버튼 상시 노출. */
  active?: boolean;
  /** 지금 재생 중인 발언 — 좌측 accent bar, 재생을 따라 이동한다. */
  playing?: boolean;
  quoted?: boolean;
  placeholder?: boolean;
  badge?: React.ReactNode;
  onJump?: () => void;
  saved?: boolean;
  /** 전사 안에서 어떤 줄이 저장됐는지 가리는 표식. 전부 저장된 목록에서는 끈다. */
  savedBadge?: boolean;
  onSaveToggle?: () => void;
  savePending?: boolean;
  onBookmark?: () => void;
  to?: string;
  children?: React.ReactNode;
};

function Utterance({
  className,
  speaker,
  name,
  time,
  active = false,
  playing = false,
  quoted = false,
  placeholder = false,
  badge = "인용",
  onJump,
  saved = false,
  savedBadge = true,
  onSaveToggle,
  savePending = false,
  onBookmark,
  to,
  children,
  onClick,
  onPointerDown,
  ...rest
}: UtteranceProps) {
  const pressAt = React.useRef<{ x: number; y: number } | null>(null);
  const root = cn(
    "group/utt relative grid grid-cols-[52px_1fr] gap-3 rounded-sm py-[7px] pr-3 pl-1.5 transition-colors duration-[80ms]",
    active ? "bg-[var(--accent-1)]" : "hover:bg-[var(--gray-1)]",
    playing && "[box-shadow:inset_2px_0_0_var(--accent-solid)]",
    className,
  );
  const textTone = placeholder
    ? "italic text-[color:var(--text-muted)]"
    : "text-foreground";
  const hasActions = Boolean(onJump || to || onSaveToggle);
  const timeCls =
    "pt-1 text-right font-mono text-xs tracking-[var(--tracking-mono)] whitespace-nowrap text-[color:var(--text-faint)]";
  const canSeek = Boolean(onJump) && !to && !quoted;
  const timeEl = canSeek ? (
    <button
      type="button"
      onClick={onJump}
      aria-label={
        typeof time === "string" ? `${time}로 이동` : "이 시점으로 이동"
      }
      className={cn(
        timeCls,
        "cursor-pointer self-start rounded-xs outline-none transition-colors duration-[80ms] hover:text-[color:var(--text-link)] hover:underline focus-visible:[box-shadow:var(--focus-ring)]",
      )}
    >
      {time}
    </button>
  ) : (
    <span className={timeCls}>{time}</span>
  );
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    pressAt.current = { x: e.clientX, y: e.clientY };
    onPointerDown?.(e);
  };
  const handleRowClick = (e: React.MouseEvent<HTMLDivElement>) => {
    onClick?.(e);
    if (!canSeek || e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, a, input, textarea, select")) return;
    if (e.detail > 1) return;
    const start = pressAt.current;
    pressAt.current = null;
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) {
      return;
    }
    const sel = window.getSelection();
    if (
      sel &&
      !sel.isCollapsed &&
      sel.toString() &&
      e.currentTarget.contains(sel.anchorNode)
    ) {
      return;
    }
    onJump?.();
  };

  if (quoted) {
    return (
      <div
        className={root}
        aria-current={playing || undefined}
        onClick={onClick}
        onPointerDown={onPointerDown}
        {...rest}
      >
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
    <div
      className={cn(root, canSeek && "cursor-pointer")}
      data-saved={saved || undefined}
      aria-current={playing || undefined}
      onClick={handleRowClick}
      onPointerDown={handlePointerDown}
      {...rest}
    >
      {timeEl}
      <div className="min-w-0">
        {/* 활성 블록은 이동 버튼(absolute)이 항상 떠 있으므로 첫 줄에 자리 확보 */}
        {hasActions && active && (
          <span aria-hidden className="float-right h-6 w-[150px]" />
        )}
        <SpeakerPill speaker={speaker} name={name} />
        {saved && savedBadge && (
          <span className="relative -top-px mr-2 inline-flex items-center rounded-full border border-[color:var(--accent-6)] bg-[var(--accent-1)] px-1.5 py-px text-2xs font-semibold text-[color:var(--accent-text)]">
            저장됨
          </span>
        )}
        {to ? (
          <Link
            to={to}
            className={cn(
              "text-read text-pretty no-underline outline-none",
              // 행 전체를 덮는 오버레이 — 어디를 눌러도 원문으로 간다.
              "after:absolute after:inset-0 after:rounded-sm",
              "focus-visible:after:[box-shadow:var(--focus-ring)]",
              textTone,
            )}
          >
            {children}
          </Link>
        ) : (
          <span className={cn("text-read text-pretty", textTone)}>
            {children}
          </span>
        )}
      </div>
      {hasActions && (
        <div
          className={cn(
            "pointer-events-none absolute top-1.5 right-2 z-10 flex items-center gap-1 transition-opacity duration-[120ms] focus-within:opacity-100 group-hover/utt:opacity-100",
            active ? "opacity-100" : "opacity-0",
          )}
        >
          <button
            type="button"
            aria-label={saved ? "저장 해제" : "발언 저장"}
            onClick={onSaveToggle}
            disabled={savePending}
            className={cn(
              "pointer-events-auto inline-flex size-6 items-center justify-center rounded-xs border outline-none disabled:cursor-wait disabled:opacity-60 focus-visible:[box-shadow:var(--focus-ring)] [&_svg]:size-[14px]",
              saved
                ? "border-[color:var(--accent-solid)] bg-[var(--accent-solid)] text-[color:var(--text-on-accent)] hover:bg-[color:var(--accent-text)]"
                : "border-border bg-card text-[color:var(--accent-text)] hover:border-[color:var(--accent-6)] hover:bg-[var(--accent-1)]",
            )}
          >
            <BookmarkIcon />
          </button>
          {to ? (
            <span
              aria-hidden
              className={cn(JUMP_CHIP, "text-[color:var(--text-link)]")}
            >
              <JumpIcon />
              <span>회의에서 보기</span>
            </span>
          ) : onJump ? (
            <button
              type="button"
              onClick={onJump}
              className={cn(
                JUMP_CHIP,
                "pointer-events-auto text-[color:var(--text-link)] outline-none hover:border-[color:var(--accent-6)] hover:bg-[var(--accent-1)] focus-visible:[box-shadow:var(--focus-ring)]",
              )}
            >
              <JumpIcon />
              <span>이 시점으로 이동</span>
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

export { Utterance };
