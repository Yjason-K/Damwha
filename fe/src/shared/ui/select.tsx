import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/lib/utils";

function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

const selectVariants = cva(
  "box-border w-full cursor-pointer appearance-none rounded-sm border border-border bg-card font-sans text-foreground transition-[color,background-color,border-color,box-shadow] duration-[80ms] ease-[cubic-bezier(0.4,0,0.2,1)] hover:border-[color:var(--border-strong)] focus-visible:border-[color:var(--border-focus)] focus-visible:outline-none focus-visible:[box-shadow:0_0_0_3px_var(--accent-2)] disabled:cursor-not-allowed disabled:bg-[var(--gray-2)] disabled:opacity-70",
  {
    variants: {
      selectSize: {
        sm: "h-7 pl-2 pr-7 text-sm",
        md: "h-8 pl-2.5 pr-[30px] text-base",
      },
    },
    defaultVariants: { selectSize: "md" },
  },
);

type SelectOption = string | { value: string; label: React.ReactNode };

type SelectProps = Omit<React.ComponentProps<"select">, "size"> &
  Pick<VariantProps<typeof selectVariants>, "selectSize"> & {
    options?: SelectOption[];
    placeholder?: string;
  };

/**
 * Select — ported from Timbre `forms/Select`. A styled native `<select>`
 * (keyboard + mobile pickers for free). Provide an accessible name via
 * `aria-label` or a wrapping `<label>`.
 */
function Select({
  className,
  selectSize,
  options = [],
  placeholder,
  children,
  ...props
}: SelectProps) {
  return (
    <span className="relative inline-flex w-full items-center">
      <select className={cn(selectVariants({ selectSize }), className)} {...props}>
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((o) => {
          const opt = typeof o === "string" ? { value: o, label: o } : o;
          return (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          );
        })}
        {children}
      </select>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-[9px] inline-flex text-[color:var(--text-muted)] [&_svg]:size-3.5"
      >
        <ChevronIcon />
      </span>
    </span>
  );
}

export { Select };
