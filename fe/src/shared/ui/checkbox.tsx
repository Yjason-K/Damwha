import * as React from "react";

import { cn } from "@/shared/lib/utils";

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 8.5l3 3 6-6" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 8h8" />
    </svg>
  );
}

type CheckboxProps = React.ComponentProps<"input"> & {
  label?: React.ReactNode;
  indeterminate?: boolean;
};

/**
 * Checkbox — ported from Timbre `forms/Checkbox`. A real native checkbox
 * (visually replaced via the `peer` pattern) so keyboard + form semantics
 * come for free. Supports `indeterminate`.
 */
function Checkbox({
  className,
  label,
  indeterminate = false,
  disabled,
  ...props
}: CheckboxProps) {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <label
      className={cn(
        "inline-flex select-none items-center gap-2 text-base text-foreground",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        className,
      )}
    >
      <input
        ref={ref}
        type="checkbox"
        disabled={disabled}
        className="peer sr-only"
        {...props}
      />
      <span
        aria-hidden="true"
        className="box-border inline-flex size-4 shrink-0 items-center justify-center rounded-xs border-[1.5px] border-[color:var(--border-strong)] bg-card text-white transition-[color,background-color,border-color,box-shadow] duration-[80ms] peer-checked:border-[color:var(--accent-solid)] peer-checked:bg-[var(--accent-solid)] peer-indeterminate:border-[color:var(--accent-solid)] peer-indeterminate:bg-[var(--accent-solid)] peer-focus-visible:[box-shadow:var(--focus-ring)] [&>svg]:size-[11px] [&>svg]:opacity-0 [&>svg]:transition-opacity peer-checked:[&>svg]:opacity-100 peer-indeterminate:[&>svg]:opacity-100"
      >
        {indeterminate ? <MinusIcon /> : <CheckIcon />}
      </span>
      {label != null && <span>{label}</span>}
    </label>
  );
}

export { Checkbox };
