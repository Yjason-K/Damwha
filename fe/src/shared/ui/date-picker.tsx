import * as React from "react";

import { cn } from "@/shared/lib/utils";
import { Calendar } from "./calendar";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

/**
 * DatePicker — radix Popover + 손수 만든 Calendar 조합. 트리거는 Input box와
 * 동일한 포커스 처리(border-focus + accent-2 ring). 값 표시 형식은 "2026.07.14".
 * 날짜만 다룬다(시간은 호출부가 별도로 관리).
 */

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}.${m}.${day}`;
}

function CalendarGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 3v3M17 3v3M4 8h16M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z" />
    </svg>
  );
}

function ClearGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

type DatePickerProps = {
  value: Date | null;
  onChange: (d: Date | null) => void;
  label?: React.ReactNode;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
};

function DatePicker({
  value,
  onChange,
  label,
  placeholder = "날짜 선택",
  disabled,
  id,
}: DatePickerProps) {
  const reactId = React.useId();
  const inputId = id ?? `${reactId}-datepicker`;
  const [open, setOpen] = React.useState(false);

  const control = (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="relative">
        <PopoverTrigger asChild>
          <button
            type="button"
            id={inputId}
            disabled={disabled}
            aria-haspopup="true"
            className={cn(
              "box-border flex h-8 w-full items-center gap-2 rounded-sm border bg-card pr-8 pl-2.5 text-base outline-none transition-[color,background-color,border-color,box-shadow] duration-[80ms] ease-[cubic-bezier(0.4,0,0.2,1)]",
              "border-border hover:border-[color:var(--border-strong)] focus-visible:border-[color:var(--border-focus)] focus-visible:[box-shadow:0_0_0_3px_var(--accent-2)]",
              "disabled:cursor-not-allowed disabled:bg-[var(--gray-2)] disabled:opacity-70",
            )}
          >
            <span className="inline-flex shrink-0 text-[color:var(--text-muted)]">
              <CalendarGlyph />
            </span>
            <span
              className={cn(
                "flex-1 text-left",
                value ? "text-foreground" : "text-[color:var(--text-faint)]",
              )}
            >
              {value ? formatDate(value) : placeholder}
            </span>
          </button>
        </PopoverTrigger>
        {value && !disabled && (
          <button
            type="button"
            aria-label="날짜 지우기"
            onClick={() => onChange(null)}
            className="absolute top-1/2 right-1.5 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-xs text-[color:var(--text-muted)] outline-none transition-colors hover:text-[color:var(--text-primary)] focus-visible:[box-shadow:0_0_0_3px_var(--accent-2)]"
          >
            <ClearGlyph />
          </button>
        )}
        <PopoverContent align="start">
          <Calendar
            value={value}
            onChange={(d) => {
              onChange(d);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </div>
    </Popover>
  );

  if (!label) return control;

  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={inputId}
        className="text-sm font-medium text-[color:var(--text-secondary)]"
      >
        {label}
      </label>
      {control}
    </div>
  );
}

export { DatePicker };
