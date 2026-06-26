import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/lib/utils";

/** Card — ported from Timbre `core/Card`. */
const cardVariants = cva(
  "box-border block rounded-md border border-border bg-card text-card-foreground",
  {
    variants: {
      padding: {
        none: "p-0",
        xs: "px-3 py-2.5",
        sm: "p-3.5",
        md: "p-[18px]",
        lg: "p-6",
      },
      raised: { true: "[box-shadow:var(--shadow-sm)]", false: "" },
      interactive: {
        true: "cursor-pointer outline-none transition-[border-color,background-color] duration-[80ms] ease-[cubic-bezier(0.4,0,0.2,1)] hover:border-[color:var(--border-strong)] hover:bg-[var(--gray-1)] focus-visible:[box-shadow:var(--focus-ring)]",
        false: "",
      },
    },
    defaultVariants: { padding: "md", raised: false, interactive: false },
  },
);

type CardProps = React.ComponentProps<"div"> &
  VariantProps<typeof cardVariants> & {
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    action?: React.ReactNode;
  };

function Card({
  className,
  padding,
  raised,
  interactive,
  title,
  subtitle,
  action,
  children,
  ...props
}: CardProps) {
  const hasHead = title || action;
  // Keep an interactive card keyboard-operable: a real click is dispatched
  // on Enter/Space so the consumer's onClick fires.
  const interactiveProps = interactive
    ? {
        role: "button" as const,
        tabIndex: 0,
        onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.currentTarget.click();
          }
        },
      }
    : {};

  return (
    <div
      data-slot="card"
      className={cn(cardVariants({ padding, raised, interactive }), className)}
      {...interactiveProps}
      {...props}
    >
      {hasHead && (
        <div className="mb-2.5 flex items-center gap-2">
          <div>
            {title && (
              <div className="text-h3 font-semibold tracking-[-0.008em] text-foreground">
                {title}
              </div>
            )}
            {subtitle && (
              <div className="mt-0.5 text-sm text-[color:var(--text-muted)]">
                {subtitle}
              </div>
            )}
          </div>
          {action && (
            <>
              <span className="flex-1" />
              {action}
            </>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

export { Card, cardVariants };
