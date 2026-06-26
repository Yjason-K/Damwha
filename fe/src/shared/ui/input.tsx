import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/lib/utils";

/**
 * Input — ported from Timbre `forms/Input`.
 * Optional label / hint / error wiring, left icon and trailing slot.
 * Focus is driven by CSS `focus-within` (no JS state); errors set
 * `aria-invalid` + `aria-describedby`.
 */
const inputBox = cva(
  "box-border flex w-full items-center gap-2 rounded-sm border bg-card text-foreground transition-[color,background-color,border-color,box-shadow] duration-[80ms] ease-[cubic-bezier(0.4,0,0.2,1)] [&_svg]:size-[15px] [&_svg]:shrink-0",
  {
    variants: {
      inputSize: {
        sm: "h-7 px-2 text-sm",
        md: "h-8 px-2.5 text-base",
        lg: "h-[38px] px-3 text-base",
      },
      invalid: {
        true: "border-[color:var(--red-9)] focus-within:[box-shadow:0_0_0_3px_var(--red-bg)]",
        false:
          "border-border hover:border-[color:var(--border-strong)] focus-within:border-[color:var(--border-focus)] focus-within:[box-shadow:0_0_0_3px_var(--accent-2)]",
      },
      disabled: {
        true: "cursor-not-allowed bg-[var(--gray-2)] opacity-70",
        false: "",
      },
    },
    defaultVariants: { inputSize: "md", invalid: false, disabled: false },
  },
);

type InputProps = Omit<React.ComponentProps<"input">, "size"> &
  Pick<VariantProps<typeof inputBox>, "inputSize"> & {
    label?: React.ReactNode;
    hint?: React.ReactNode;
    error?: React.ReactNode;
    iconLeft?: React.ReactNode;
    trailing?: React.ReactNode;
    containerClassName?: string;
  };

function Input({
  className,
  containerClassName,
  inputSize,
  label,
  hint,
  error,
  iconLeft,
  trailing,
  disabled,
  id,
  ...props
}: InputProps) {
  const reactId = React.useId();
  const inputId = id ?? `${reactId}-input`;
  const descId = error || hint ? `${reactId}-desc` : undefined;
  const invalid = !!error;

  const box = (
    <div className={inputBox({ inputSize, invalid, disabled: !!disabled })}>
      {iconLeft && (
        <span className="inline-flex shrink-0 items-center text-[color:var(--text-muted)]">
          {iconLeft}
        </span>
      )}
      <input
        id={inputId}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={descId}
        className={cn(
          "w-full min-w-0 flex-1 border-0 bg-transparent p-0 font-sans text-inherit outline-none [font-size:inherit] placeholder:text-[color:var(--text-faint)] disabled:cursor-not-allowed",
          className,
        )}
        {...props}
      />
      {trailing && <span className="shrink-0">{trailing}</span>}
    </div>
  );

  if (!label && !hint && !error) {
    return <div className={containerClassName}>{box}</div>;
  }

  return (
    <div className={cn("flex flex-col gap-1.5", containerClassName)}>
      {label && (
        <label
          htmlFor={inputId}
          className="text-sm font-medium text-[color:var(--text-secondary)]"
        >
          {label}
        </label>
      )}
      {box}
      {(error || hint) && (
        <span
          id={descId}
          className={cn(
            "text-xs",
            error
              ? "text-[color:var(--red-text)]"
              : "text-[color:var(--text-muted)]",
          )}
        >
          {error || hint}
        </span>
      )}
    </div>
  );
}

export { Input };
