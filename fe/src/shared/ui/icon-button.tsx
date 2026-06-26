import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/lib/utils";

/**
 * IconButton — ported from Timbre `core/IconButton`.
 * `label` is required (becomes the accessible name). Pass `pressed` for a
 * toggle (renders aria-pressed).
 */
const iconButtonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-sm border border-transparent bg-transparent text-[color:var(--text-secondary)] outline-none transition-[color,background-color,border-color,box-shadow] duration-[80ms] ease-[cubic-bezier(0.4,0,0.2,1)] hover:bg-accent hover:text-foreground active:translate-y-[0.5px] focus-visible:[box-shadow:var(--focus-ring)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-[var(--accent-bg)] aria-pressed:text-[color:var(--accent-text)] [&_svg]:block [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        ghost: "",
        outline: "border-border bg-card",
      },
      size: {
        sm: "size-[26px] [&_svg]:size-[15px]",
        md: "size-[30px] [&_svg]:size-[17px]",
        lg: "size-9 [&_svg]:size-[19px]",
      },
    },
    defaultVariants: { variant: "ghost", size: "md" },
  },
);

type IconButtonProps = Omit<React.ComponentProps<"button">, "aria-label"> &
  VariantProps<typeof iconButtonVariants> & {
    label: string;
    pressed?: boolean;
  };

function IconButton({
  className,
  variant,
  size,
  label,
  pressed,
  type = "button",
  ...props
}: IconButtonProps) {
  return (
    <button
      data-slot="icon-button"
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cn(iconButtonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { IconButton, iconButtonVariants };
