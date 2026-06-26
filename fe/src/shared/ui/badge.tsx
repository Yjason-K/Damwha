import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/lib/utils";

/** Badge — ported from Timbre `core/Badge`. */
const badgeVariants = cva(
  "box-border inline-flex items-center gap-[5px] whitespace-nowrap rounded-xs border border-transparent px-[7px] py-[3px] text-xs font-medium leading-none [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        neutral:
          "border-border bg-[var(--gray-2)] text-[color:var(--text-secondary)]",
        accent: "bg-[var(--accent-2)] text-[color:var(--accent-text)]",
        success: "bg-success-bg text-success-text",
        warning: "bg-warning-bg text-warning-text",
        danger: "bg-danger-bg text-danger-text",
        outline: "border-border bg-transparent text-[color:var(--text-muted)]",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

type BadgeProps = React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    dot?: boolean;
    icon?: React.ReactNode;
  };

function Badge({
  className,
  variant,
  dot = false,
  icon,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    >
      {dot && (
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full bg-current"
        />
      )}
      {icon}
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
