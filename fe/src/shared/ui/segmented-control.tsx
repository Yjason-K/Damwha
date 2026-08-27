import * as React from "react";

import { cn } from "@/shared/lib/utils";

/**
 * SegmentedControl — 배타적인 소수(2~3개)의 선택지를 한 줄에 나란히 놓는
 * 라디오 그룹. `Switch`와 같은 방식으로 네이티브 `<input type="radio">`를
 * `sr-only`로 깔고 라벨이 감싸므로 화살표 키 이동·라벨 클릭·포커스 링을
 * 브라우저에서 그대로 받는다. 선택 상태는 `peer-checked` 대신 JS로 계산해
 * 칠한다 — hover와 checked가 같은 속성을 다투는 걸 피하려는 것.
 */

type SegmentedControlOption<T extends string> = {
  value: T;
  label: React.ReactNode;
  /** 라벨이 짧아 그룹 밖에서 뜻이 흐려질 때 붙이는 접근 가능한 이름. */
  ariaLabel?: string;
};

type SegmentedControlProps<T extends string> = {
  options: SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** 라디오 그룹 name — 생략하면 인스턴스마다 자동 생성한다. */
  name?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
};

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  name,
  disabled,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: SegmentedControlProps<T>) {
  const autoName = React.useId();

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-sm border border-border bg-[var(--surface-sunken)] p-0.5",
        disabled && "opacity-50",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <label
            key={option.value}
            className={cn(
              "flex-1",
              disabled ? "cursor-not-allowed" : "cursor-pointer",
            )}
          >
            <input
              type="radio"
              name={name ?? autoName}
              value={option.value}
              checked={active}
              disabled={disabled}
              aria-label={option.ariaLabel}
              onChange={() => onChange(option.value)}
              className="peer sr-only"
            />
            <span
              className={cn(
                "block touch-manipulation rounded-xs px-2.5 py-1 text-center text-sm font-medium whitespace-nowrap transition-colors duration-[80ms] ease-[cubic-bezier(0.4,0,0.2,1)] peer-focus-visible:[box-shadow:var(--focus-ring)]",
                active
                  ? "bg-[var(--accent-bg)] text-[color:var(--accent-text)]"
                  : "text-[color:var(--text-muted)] peer-enabled:hover:text-foreground",
              )}
            >
              {option.label}
            </span>
          </label>
        );
      })}
    </div>
  );
}

export { SegmentedControl };
