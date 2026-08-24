# DatePicker (Timbre) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 회의 업로드 모달의 "녹음 일시" 필드를 브라우저 기본 `datetime-local` 대신 Timbre 토큰에 맞춘 DatePicker(달력) + 시간 입력으로 교체한다.

**Architecture:** `radix-ui` Popover 위에 손수 만든 달력 그리드(의존성 0)를 얹는다. 재사용 컴포넌트 3개(`popover` / `calendar` / `date-picker`)를 `src/shared/ui/`에 만들고, 업로드 모달만 이를 사용하도록 배선한다. 업로드 API 계약(ISO 문자열 `recordedAt`)은 변경하지 않는다.

**Tech Stack:** React 19, TypeScript strict + `verbatimModuleSyntax`, Tailwind v4 (CSS-first, Timbre 토큰), `radix-ui` 1.6, Vitest + Testing Library.

## Global Constraints

- **Node 22 + pnpm.** 셸이 Node 20이면 명령마다 `nvm use 22 && pnpm ...`.
- **의존성 0 추가.** 새 npm 패키지 금지(react-day-picker/date-fns 등 사용 안 함).
- **type-only import은 `import type { ... }`** (verbatimModuleSyntax). `noUnusedLocals`/`noUnusedParameters` on.
- **Prettier:** 큰따옴표, 세미콜론, trailing comma `all`, printWidth 80. 종료 전 `pnpm format`.
- **색/간격은 Timbre 시맨틱 토큰**(`--text-*`, `--border-*`, `bg-primary`, `bg-card`, `bg-popover` 등) 참조. 원시 스케일 직접 참조 지양.
- **UI 카피는 한국어.**
- **`shared/ui`는 `features/`를 import 금지** — 아이콘은 인라인 SVG로.
- 새 `<name>Variants` CVA export 없음 → eslint `allowExportNames` 수정 불필요.

---

### Task 1: Calendar (손수 만든 월 그리드)

**Files:**
- Create: `src/shared/ui/calendar.tsx`
- Test: `src/shared/ui/calendar.test.tsx`

**Interfaces:**
- Consumes: `cn` from `@/shared/lib/utils`.
- Produces: `export { Calendar }` — `function Calendar(props: { value: Date | null; onChange: (d: Date) => void; disabled?: boolean }): JSX.Element`. `onChange`는 항상 로컬 자정으로 정규화된 `Date`를 넘긴다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/shared/ui/calendar.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { Calendar } from "./calendar";

afterEach(cleanup);

test("특정 일 클릭 시 로컬 자정 Date로 onChange 호출", () => {
  const onChange = vi.fn();
  render(<Calendar value={new Date(2026, 6, 1)} onChange={onChange} />);

  fireEvent.click(screen.getByRole("button", { name: "2026년 7월 15일" }));

  expect(onChange).toHaveBeenCalledTimes(1);
  const d = onChange.mock.calls[0][0] as Date;
  expect(d.getFullYear()).toBe(2026);
  expect(d.getMonth()).toBe(6);
  expect(d.getDate()).toBe(15);
  expect(d.getHours()).toBe(0);
  expect(d.getMinutes()).toBe(0);
});

test("다음 달 버튼으로 월 이동", () => {
  render(<Calendar value={new Date(2026, 6, 1)} onChange={() => {}} />);
  expect(screen.getByText("2026년 7월")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "다음 달" }));
  expect(screen.getByText("2026년 8월")).toBeTruthy();
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `nvm use 22 && pnpm vitest run src/shared/ui/calendar.test.tsx`
Expected: FAIL — `Failed to resolve import "./calendar"`.

- [ ] **Step 3: Calendar 구현**

`src/shared/ui/calendar.tsx`:

```tsx
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
    setFocusDate((d) => startOfDay(new Date(d.getFullYear(), d.getMonth() + delta, 1)));
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
            <div role="gridcell" key={dayKey(d)} aria-selected={selected}>
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
                  isToday && !selected && "ring-1 ring-inset ring-[color:var(--border-focus)]",
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
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `nvm use 22 && pnpm vitest run src/shared/ui/calendar.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: 커밋**

```bash
cd /Users/gim-yeongjae/project/daewha/fe
git add src/shared/ui/calendar.tsx src/shared/ui/calendar.test.tsx
git commit -m "feat(ui): 손수 만든 Calendar 월 그리드 추가"
```

---

### Task 2: Popover 래퍼

**Files:**
- Create: `src/shared/ui/popover.tsx`

**Interfaces:**
- Consumes: `radix-ui` Popover 프리미티브, `cn`.
- Produces: `export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor }`. `Popover`는 제어형(`open` / `onOpenChange`) 사용 가능. `PopoverContent`는 `align`(기본 `"start"`) / `sideOffset`(기본 4) props.

- [ ] **Step 1: Popover 래퍼 작성**

`src/shared/ui/popover.tsx`:

```tsx
import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";

import { cn } from "@/shared/lib/utils";

/**
 * Popover — shadcn Radix Popover(radix-ui)를 Damwha(Timbre) 토큰으로 재스킨.
 * Content는 Select와 동일한 popover 표면 + shadow-md + open/close 애니메이션.
 */

function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger(
  props: React.ComponentProps<typeof PopoverPrimitive.Trigger>,
) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverAnchor(
  props: React.ComponentProps<typeof PopoverPrimitive.Anchor>,
) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

function PopoverContent({
  className,
  align = "start",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-auto origin-(--radix-popover-content-transform-origin) rounded-md border border-border bg-popover text-popover-foreground outline-none [box-shadow:var(--shadow-md)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
```

- [ ] **Step 2: 타입/린트 확인**

Run: `nvm use 22 && pnpm exec tsc -b && pnpm exec eslint src/shared/ui/popover.tsx`
Expected: 오류 없음. (radix-ui가 `Popover` 네임드 export를 제공하는지 여기서 검증됨.)

- [ ] **Step 3: 커밋**

```bash
cd /Users/gim-yeongjae/project/daewha/fe
git add src/shared/ui/popover.tsx
git commit -m "feat(ui): radix Popover 래퍼 추가"
```

---

### Task 3: DatePicker (Popover + Calendar 조합)

**Files:**
- Create: `src/shared/ui/date-picker.tsx`
- Test: `src/shared/ui/date-picker.test.tsx`

**Interfaces:**
- Consumes: `Calendar`(Task 1), `Popover`/`PopoverTrigger`/`PopoverContent`(Task 2), `cn`.
- Produces: `export { DatePicker }` — `function DatePicker(props: { value: Date | null; onChange: (d: Date | null) => void; label?: React.ReactNode; placeholder?: string; disabled?: boolean; id?: string }): JSX.Element`. 트리거 버튼은 `w-full`. 날짜 선택 시 팝오버 자동 닫힘 + `onChange(date)`. clear 시 `onChange(null)`.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/shared/ui/date-picker.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { DatePicker } from "./date-picker";

afterEach(cleanup);

test("팝오버에서 날짜 선택 시 해당 Date로 onChange 호출", () => {
  const onChange = vi.fn();
  render(<DatePicker value={new Date(2026, 6, 1)} onChange={onChange} />);

  // 트리거(현재 값 표시)를 클릭해 팝오버 열기
  fireEvent.click(screen.getByRole("button", { name: /2026\.07\.01/ }));
  fireEvent.click(screen.getByRole("button", { name: "2026년 7월 15일" }));

  expect(onChange).toHaveBeenCalledTimes(1);
  const d = onChange.mock.calls[0][0] as Date;
  expect(d.getFullYear()).toBe(2026);
  expect(d.getMonth()).toBe(6);
  expect(d.getDate()).toBe(15);
});

test("clear 버튼이 null로 onChange 호출", () => {
  const onChange = vi.fn();
  render(<DatePicker value={new Date(2026, 6, 1)} onChange={onChange} />);

  fireEvent.click(screen.getByRole("button", { name: "날짜 지우기" }));
  expect(onChange).toHaveBeenCalledWith(null);
});

test("값 없으면 placeholder 표시", () => {
  render(<DatePicker value={null} onChange={() => {}} placeholder="날짜 선택" />);
  expect(screen.getByText("날짜 선택")).toBeTruthy();
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `nvm use 22 && pnpm vitest run src/shared/ui/date-picker.test.tsx`
Expected: FAIL — `Failed to resolve import "./date-picker"`.

- [ ] **Step 3: DatePicker 구현**

`src/shared/ui/date-picker.tsx`:

```tsx
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
            aria-haspopup="dialog"
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
                value
                  ? "text-foreground"
                  : "text-[color:var(--text-faint)]",
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
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `nvm use 22 && pnpm vitest run src/shared/ui/date-picker.test.tsx`
Expected: PASS (3 tests).

> 주의: Radix Popover는 클릭으로 열린다(`vitest.setup.ts`의 Pointer Capture 폴리필로 jsdom에서 동작). 만약 클릭으로 열리지 않으면 트리거에 `.focus()` 후 `fireEvent.keyDown(trigger, { key: "Enter" })`로 대체.

- [ ] **Step 5: 커밋**

```bash
cd /Users/gim-yeongjae/project/daewha/fe
git add src/shared/ui/date-picker.tsx src/shared/ui/date-picker.test.tsx
git commit -m "feat(ui): DatePicker(Popover+Calendar) 추가"
```

---

### Task 4: 업로드 모달 배선

**Files:**
- Modify: `src/features/meeting/ui/upload-dialog.tsx`

**Interfaces:**
- Consumes: `DatePicker`(Task 3), 기존 `Input`(`type="time"`).
- Produces: 없음(내부 배선). `useUploadMeeting` 요청 계약(ISO `recordedAt`) 불변.

- [ ] **Step 1: import 추가**

`upload-dialog.tsx` 상단 import 블록의 `Input` import 아래에 추가:

```tsx
import { DatePicker } from "@/shared/ui/date-picker";
```

- [ ] **Step 2: 날짜+시간 → ISO 조합 헬퍼 추가**

`formatBytes` 함수 바로 아래(파일 상단 유틸 영역)에 추가:

```tsx
/** 날짜 + "HH:MM"(비면 자정)을 로컬 시각 기준 ISO 문자열로 합친다. */
function combineToISO(date: Date, time: string): string {
  const [h, m] = time ? time.split(":").map(Number) : [0, 0];
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    h || 0,
    m || 0,
  ).toISOString();
}
```

- [ ] **Step 3: 상태 교체**

`const [recordedAt, setRecordedAt] = React.useState("");` (line 51) 를 다음으로 교체:

```tsx
const [recordedDate, setRecordedDate] = React.useState<Date | null>(null);
const [recordedTime, setRecordedTime] = React.useState("");
```

`resetForm` 안의 `setRecordedAt("");` 를 다음으로 교체:

```tsx
setRecordedDate(null);
setRecordedTime("");
```

- [ ] **Step 4: 제출 페이로드 교체**

`handleSubmit`의 `upload.mutate` 첫 인자에서

```tsx
recordedAt: recordedAt ? new Date(recordedAt).toISOString() : undefined,
```

를 다음으로 교체:

```tsx
recordedAt: recordedDate
  ? combineToISO(recordedDate, recordedTime)
  : undefined,
```

- [ ] **Step 5: 필드 UI 교체**

기존 녹음 일시 `<Input type="datetime-local" .../>` 블록 전체를 다음으로 교체:

```tsx
<div className="flex flex-col gap-1.5">
  <span className="text-sm font-medium text-[color:var(--text-secondary)]">
    녹음 일시 (선택)
  </span>
  <div className="flex items-center gap-2">
    <div className="min-w-0 flex-1">
      <DatePicker value={recordedDate} onChange={setRecordedDate} />
    </div>
    <Input
      type="time"
      value={recordedTime}
      onChange={(e) => setRecordedTime(e.target.value)}
      containerClassName="w-[116px] shrink-0"
      aria-label="녹음 시각"
    />
  </div>
</div>
```

- [ ] **Step 6: 타입체크 + 테스트 + 포맷**

Run:
```bash
nvm use 22 && pnpm exec tsc -b \
  && pnpm vitest run src/features/meeting/ui/upload-dialog.test.tsx \
  && pnpm format
```
Expected: tsc 오류 없음, 기존 업로드 테스트 PASS(녹음 일시에 의존하지 않음), prettier 정리 완료.

- [ ] **Step 7: 커밋**

```bash
cd /Users/gim-yeongjae/project/daewha/fe
git add src/features/meeting/ui/upload-dialog.tsx
git commit -m "feat(meeting): 업로드 모달 녹음 일시를 DatePicker+시간 입력으로 교체"
```

---

## 완료 검증

- [ ] `nvm use 22 && pnpm build` (tsc -b + vite) 통과
- [ ] `nvm use 22 && pnpm lint` 통과
- [ ] `nvm use 22 && pnpm vitest run` 전체 통과
- [ ] 수동: 업로드 모달 열어 달력에서 날짜 선택 → 시간 입력 → 업로드 시 `recordedAt`가 올바른 ISO로 전송되는지 확인. 날짜 미선택 시 `recordedAt` 미전송 확인.
