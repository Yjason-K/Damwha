import * as React from "react";

import { cn } from "@/shared/lib/utils";

/**
 * Calendar — 손수 만든 월 그리드(의존성 0). DatePicker가 radix Popover 안에서
 * 사용한다. 날짜만 다루며 시간은 소유하지 않는다. onChange는 항상 로컬 자정으로
 * 정규화된 Date를 넘긴다. 방향키로 포커스 이동, PageUp/PageDown으로 월 이동.
 */

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function isSameDay(a: Date | null, b: Date | null): boolean {
  if (!a || !b) return false;
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 로컬 날짜 키(포커스 대상 조회용). */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** month(1일)이 속한 주의 일요일부터 42칸. */
function buildGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

function ChevronLeft() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 4l-4 4 4 4" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

type CalendarProps = {
  value: Date | null;
  onChange: (d: Date) => void;
  disabled?: boolean;
};

function Calendar({ value, onChange, disabled }: CalendarProps) {
  const today = startOfDay(new Date());
  const [focusDate, setFocusDate] = React.useState<Date>(() =>
    startOfDay(value ?? today),
  );
  const shouldFocusRef = React.useRef(false);
  const gridRef = React.useRef<HTMLDivElement>(null);

  const year = focusDate.getFullYear();
  const month = focusDate.getMonth();
  const grid = buildGrid(year, month);

  React.useEffect(() => {
    if (!shouldFocusRef.current) return;
    shouldFocusRef.current = false;
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`[data-day="${dayKey(focusDate)}"]`)
      ?.focus();
  }, [focusDate]);

  const moveDays = (days: number) => {
    shouldFocusRef.current = true;
    setFocusDate((d) => {
      const n = new Date(d);
      n.setDate(d.getDate() + days);
      return startOfDay(n);
    });
  };

  const shiftMonth = (delta: number, focus = false) => {
    shouldFocusRef.current = focus;
    setFocusDate((d) =>
      startOfDay(new Date(d.getFullYear(), d.getMonth() + delta, 1)),
    );
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        moveDays(-1);
        break;
      case "ArrowRight":
        e.preventDefault();
        moveDays(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveDays(-7);
        break;
      case "ArrowDown":
        e.preventDefault();
        moveDays(7);
        break;
      case "PageUp":
        e.preventDefault();
        shiftMonth(-1, true);
        break;
      case "PageDown":
        e.preventDefault();
        shiftMonth(1, true);
        break;
    }
  };

  const navBtn =
    "inline-flex size-7 items-center justify-center rounded-sm text-[color:var(--text-muted)] outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:[box-shadow:0_0_0_3px_var(--accent-2)] disabled:opacity-50";

  return (
    <div className="w-[248px] select-none p-2">
      <div className="mb-1 flex items-center justify-between px-1">
        <button
          type="button"
          className={navBtn}
          onClick={() => shiftMonth(-1)}
          aria-label="이전 달"
          disabled={disabled}
        >
          <ChevronLeft />
        </button>
        <span
          className="text-sm font-medium text-[color:var(--text-primary)]"
          aria-live="polite"
        >
          {year}년 {month + 1}월
        </span>
        <button
          type="button"
          className={navBtn}
          onClick={() => shiftMonth(1)}
          aria-label="다음 달"
          disabled={disabled}
        >
          <ChevronRight />
        </button>
      </div>

      <div
        ref={gridRef}
        className="grid grid-cols-7"
        role="grid"
        onKeyDown={onKeyDown}
      >
        {WEEKDAYS.map((w, i) => (
          <div
            key={w}
            role="columnheader"
            className={cn(
              "flex h-7 items-center justify-center text-xs font-medium",
              i === 0
                ? "text-[color:var(--red-text)]"
                : "text-[color:var(--text-muted)]",
            )}
          >
            {w}
          </div>
        ))}

        {grid.map((d) => {
          const inMonth = d.getMonth() === month;
          const selected = isSameDay(d, value);
          const isToday = isSameDay(d, today);
          const focusable = isSameDay(d, focusDate);
          return (
            <div
              role="gridcell"
              key={dayKey(d)}
              aria-selected={selected}
            >
              <button
                type="button"
                data-day={dayKey(d)}
                disabled={disabled}
                tabIndex={focusable ? 0 : -1}
                onClick={() => onChange(startOfDay(d))}
                aria-label={`${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`}
                aria-current={isToday ? "date" : undefined}
                className={cn(
                  "flex size-8 items-center justify-center rounded-sm text-sm outline-none transition-colors focus-visible:[box-shadow:0_0_0_3px_var(--accent-2)]",
                  !inMonth && "text-[color:var(--text-faint)]",
                  inMonth &&
                    !selected &&
                    "text-[color:var(--text-primary)] hover:bg-accent hover:text-accent-foreground",
                  selected && "bg-primary text-primary-foreground",
                  isToday &&
                    !selected &&
                    "ring-1 ring-inset ring-[color:var(--border-focus)]",
                )}
              >
                {d.getDate()}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export { Calendar };
