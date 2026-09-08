import * as React from "react";

import { cn } from "@/shared/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

/**
 * TimePicker — radix Popover + 시/분 두 열의 스크롤 목록. 트리거는 DatePicker와
 * 똑같은 Input box 포커스 처리(border-focus + accent-2 ring)를 쓰고, 값은
 * 브라우저 `<input type="time">`과 같은 "HH:MM" 문자열이라 호출부의 날짜+시각
 * 결합 계산식을 그대로 둔 채 갈아끼울 수 있다. 시각만 다룬다(날짜는 호출부가
 * 별도로 관리). 값이 없으면 빈 문자열 — DatePicker의 null과 같은 자리다.
 */

const HOURS = Array.from({ length: 24 }, (_, i) => i);

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "HH:MM" → [시, 분]. 그 형식이 아니면 null. */
function parseTime(v: string): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return [h, min];
}

/**
 * step 간격의 분 목록. 현재 값이 격자 위에 없으면(예: step 5에 37분) 그 값을
 * 끼워 넣는다 — 목록에 없으면 선택 표시도, 스크롤 위치도 잃는다.
 */
function buildMinutes(step: number, current: number | null): number[] {
  const list: number[] = [];
  for (let m = 0; m < 60; m += step) list.push(m);
  if (current !== null && !list.includes(current)) {
    list.push(current);
    list.sort((a, b) => a - b);
  }
  return list;
}

function ClockGlyph() {
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
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.75" />
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

type TimeColumnProps = {
  label: string;
  values: number[];
  selected: number | null;
  onSelect: (v: number) => void;
};

/**
 * 한 열(시 또는 분). roving tabindex라 Tab은 열 하나를 통째로 건너뛰고, 열
 * 안에서는 방향키/Home/End로 움직인다(위아래로 순환).
 */
function TimeColumn({ label, values, selected, onSelect }: TimeColumnProps) {
  const listRef = React.useRef<HTMLDivElement>(null);

  // 열릴 때 선택값을 가운데로. scrollIntoView는 조상까지 같이 굴려서 모달이
  // 튀므로 이 컨테이너의 scrollTop만 직접 잡는다.
  React.useEffect(() => {
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>('[data-selected="true"]');
    if (!list || !item) return;
    list.scrollTop =
      item.offsetTop - list.clientHeight / 2 + item.offsetHeight / 2;
  }, []);

  const items = () =>
    Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    );

  const focusAt = (i: number) => {
    const all = items();
    if (all.length === 0) return;
    all[(i + all.length) % all.length].focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const all = items();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusAt(i + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusAt(i - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusAt(all.length - 1);
    }
  };

  return (
    <div className="flex min-w-0 flex-col">
      <div
        aria-hidden="true"
        className="px-2 pt-2 pb-1 text-center text-xs text-[color:var(--text-muted)]"
      >
        {label}
      </div>
      <div
        ref={listRef}
        role="listbox"
        aria-label={label}
        onKeyDown={handleKeyDown}
        className="flex h-[196px] w-14 flex-col gap-0.5 overflow-y-auto overscroll-contain px-1 pb-1 [scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[color:var(--border-strong)] [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:w-1.5"
      >
        {values.map((v, i) => {
          const isSelected = v === selected;
          return (
            <button
              key={v}
              type="button"
              role="option"
              aria-selected={isSelected}
              data-selected={isSelected || undefined}
              tabIndex={isSelected || (selected === null && i === 0) ? 0 : -1}
              onClick={() => onSelect(v)}
              className={cn(
                "shrink-0 rounded-xs py-1 text-center text-base tabular-nums outline-none transition-colors duration-[80ms] hover:bg-accent hover:text-accent-foreground focus-visible:[box-shadow:0_0_0_2px_var(--border-focus)]",
                isSelected
                  ? "bg-[color:var(--accent-bg)] font-medium text-[color:var(--accent-text)]"
                  : "text-foreground",
              )}
            >
              {pad2(v)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

type TimePickerProps = {
  value: string;
  onChange: (t: string) => void;
  label?: React.ReactNode;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  /** 분 목록 간격(분). 기본 5 — 격자 밖의 값도 목록에 끼워 넣는다. */
  minuteStep?: number;
  "aria-label"?: string;
};

function TimePicker({
  value,
  onChange,
  label,
  placeholder = "--:--",
  disabled,
  id,
  minuteStep = 5,
  "aria-label": ariaLabel,
}: TimePickerProps) {
  const reactId = React.useId();
  const inputId = id ?? `${reactId}-timepicker`;
  const [open, setOpen] = React.useState(false);

  const parsed = parseTime(value);
  const hour = parsed?.[0] ?? null;
  const minute = parsed?.[1] ?? null;
  const minutes = buildMinutes(minuteStep, minute);

  // 한쪽만 고르면 나머지는 00으로 채운다 — 반쪽짜리 값은 만들지 않는다.
  const commit = (h: number | null, m: number | null) =>
    onChange(`${pad2(h ?? 0)}:${pad2(m ?? 0)}`);

  const control = (
    /**
     * modal — 이 픽커는 modal Dialog 안에서 열린다. Dialog는 react-remove-scroll로
     * 자기 DOM 밖의 wheel을 preventDefault하는데, Popover는 body로 portal되므로
     * 시/분 목록이 휠에 전혀 반응하지 않았다(스크롤 컨테이너 자체는 멀쩡했다).
     * modal이면 Popover도 자기 lock을 쌓고, 안쪽 lock이 이겨서 목록이 다시 구른다.
     */
    <Popover open={open} onOpenChange={setOpen} modal>
      <div className="relative">
        <PopoverTrigger asChild>
          <button
            type="button"
            id={inputId}
            disabled={disabled}
            aria-haspopup="true"
            aria-label={ariaLabel}
            className={cn(
              "box-border flex h-8 w-full items-center gap-2 rounded-sm border bg-card pr-8 pl-2.5 text-base outline-none transition-[color,background-color,border-color,box-shadow] duration-[80ms] ease-[cubic-bezier(0.4,0,0.2,1)]",
              "border-border hover:border-[color:var(--border-strong)] focus-visible:border-[color:var(--border-focus)] focus-visible:[box-shadow:0_0_0_3px_var(--accent-2)]",
              "disabled:cursor-not-allowed disabled:bg-[var(--gray-2)] disabled:opacity-70",
            )}
          >
            <span className="inline-flex shrink-0 text-[color:var(--text-muted)]">
              <ClockGlyph />
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-left tabular-nums",
                parsed ? "text-foreground" : "text-[color:var(--text-faint)]",
              )}
            >
              {parsed ? `${pad2(parsed[0])}:${pad2(parsed[1])}` : placeholder}
            </span>
          </button>
        </PopoverTrigger>
        {parsed && !disabled && (
          <button
            type="button"
            aria-label="시각 지우기"
            onClick={() => onChange("")}
            className="absolute top-1/2 right-1.5 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-xs text-[color:var(--text-muted)] outline-none transition-colors hover:text-[color:var(--text-primary)] focus-visible:[box-shadow:0_0_0_3px_var(--accent-2)]"
          >
            <ClearGlyph />
          </button>
        )}
        <PopoverContent align="start" className="flex gap-1 p-0">
          <TimeColumn
            label="시"
            values={HOURS}
            selected={hour}
            onSelect={(h) => commit(h, minute)}
          />
          <div aria-hidden="true" className="my-2 w-px shrink-0 bg-border" />
          <TimeColumn
            label="분"
            values={minutes}
            selected={minute}
            onSelect={(m) => commit(hour, m)}
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

export { TimePicker };
