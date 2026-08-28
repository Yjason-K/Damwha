import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/lib/utils";

/**
 * Button — ported from the Damwha Design System (Timbre) `core/Button`.
 * variants: primary | secondary | ghost | danger · sizes: sm | md | lg.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-sm font-medium tracking-[-0.008em] outline-none transition-[color,background-color,border-color,box-shadow] duration-[80ms] ease-[cubic-bezier(0.4,0,0.2,1)] focus-visible:[box-shadow:var(--focus-ring)] active:translate-y-[0.5px] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:size-[15px] [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary:
          "bg-primary text-primary-foreground hover:bg-[var(--accent-solid-hover)]",
        secondary:
          "border border-border bg-card text-foreground hover:border-[color:var(--border-strong)] hover:bg-[var(--gray-2)]",
        ghost:
          "text-[color:var(--text-secondary)] hover:bg-accent hover:text-accent-foreground",
        danger: "bg-[var(--red-9)] text-white hover:bg-[#a3242f]",
      },
      size: {
        sm: "h-7 px-2.5 text-sm",
        md: "h-8 px-3 text-base",
        lg: "h-[38px] px-4 text-base",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    loading?: boolean;
    iconLeft?: React.ReactNode;
    iconRight?: React.ReactNode;
    fullWidth?: boolean;
  };

function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  iconLeft,
  iconRight,
  fullWidth = false,
  type = "button",
  disabled,
  children,
  ...props
}: ButtonProps) {
  const classes = cn(
    buttonVariants({ variant, size }),
    fullWidth && "w-full",
    className,
  );

  // asChild renders the consumer's element (e.g. a link); icon/loading
  // decoration is skipped since Slot expects a single child.
  if (asChild) {
    return (
      <Slot data-slot="button" className={classes} {...props}>
        {children}
      </Slot>
    );
  }

  return (
    <button
      data-slot="button"
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={classes}
      {...props}
    >
      {loading && (
        <span
          aria-hidden="true"
          className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent"
        />
      )}
      {!loading && iconLeft}
      {children != null && <span>{children}</span>}
      {!loading && iconRight}
    </button>
  );
}

export { Button, buttonVariants };
