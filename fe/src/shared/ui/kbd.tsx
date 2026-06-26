import * as React from "react";

import { cn } from "@/shared/lib/utils";

/** Kbd — ported from Timbre `core/Kbd`. Pass `keys` for a combo group. */
const keyClass =
  "box-border inline-flex h-[18px] min-w-[18px] items-center justify-center gap-px rounded-xs border border-border border-b-2 bg-[var(--gray-1)] px-[5px] font-mono text-2xs font-medium tracking-[var(--tracking-mono)] text-[color:var(--text-secondary)]";
const keyClassLg = "h-[22px] min-w-[22px] px-1.5 text-xs";

type KbdProps = Omit<React.ComponentProps<"kbd">, "children"> & {
  children?: React.ReactNode;
  keys?: string[];
  size?: "sm" | "lg";
};

function Kbd({ className, children, keys, size = "sm", ...props }: KbdProps) {
  const cls = cn(keyClass, size === "lg" && keyClassLg, className);

  if (Array.isArray(keys)) {
    return (
      <span className="inline-flex items-center gap-[3px]">
        {keys.map((k, i) => (
          <kbd key={i} className={cls}>
            {k}
          </kbd>
        ))}
      </span>
    );
  }

  return (
    <kbd className={cls} {...props}>
      {children}
    </kbd>
  );
}

export { Kbd };
