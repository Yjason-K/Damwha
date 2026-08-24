import * as React from "react";

import { cn } from "@/shared/lib/utils";

type SwitchProps = React.ComponentProps<"input"> & {
  label?: React.ReactNode;
};

/**
 * Switch — ported from Timbre `forms/Switch`. A native checkbox with
 * `role="switch"` behind a custom track/thumb (via the `peer` pattern).
 */
function Switch({ className, label, disabled, ...props }: SwitchProps) {
  return (
    <label
      className={cn(
        "inline-flex select-none items-center gap-[9px] text-base text-foreground",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        className,
      )}
    >
      <input
        type="checkbox"
        role="switch"
        disabled={disabled}
        className="peer sr-only"
        {...props}
      />
      <span
        aria-hidden="true"
        className="relative inline-flex h-[18px] w-8 shrink-0 rounded-full bg-[var(--gray-5)] transition-colors duration-[120ms] ease-[cubic-bezier(0.4,0,0.2,1)] peer-checked:bg-[var(--accent-solid)] peer-focus-visible:[box-shadow:var(--focus-ring)] peer-checked:[&>span]:translate-x-[14px]"
      >
        <span className="absolute left-0.5 top-0.5 size-3.5 rounded-full bg-white shadow-[0_1px_2px_rgba(20,23,28,0.25)] transition-transform duration-[120ms] ease-[cubic-bezier(0.16,1,0.3,1)]" />
      </span>
      {label != null && <span>{label}</span>}
    </label>
  );
}

export { Switch };
