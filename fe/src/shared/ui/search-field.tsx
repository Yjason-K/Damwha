import * as React from "react";

import { cn } from "@/shared/lib/utils";

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" strokeLinecap="round" />
    </svg>
  );
}

const base =
  "box-border flex h-8 w-full items-center gap-2 rounded-sm border border-border bg-[var(--gray-1)] pl-2.5 pr-2 text-[color:var(--text-muted)] transition-[color,background-color,border-color,box-shadow] duration-[80ms] ease-[cubic-bezier(0.4,0,0.2,1)] hover:border-[color:var(--border-strong)] hover:bg-card [&_svg]:size-[15px] [&_svg]:shrink-0 [&_input::-webkit-search-cancel-button]:appearance-none";

type SearchFieldProps = Omit<React.ComponentProps<"input">, "type"> & {
  /** Render as a ⌘K trigger button instead of a live input. */
  asButton?: boolean;
  shortcut?: React.ReactNode;
  onClick?: React.MouseEventHandler;
  className?: string;
};

/** SearchField — ported from Timbre `forms/SearchField`. */
function SearchField({
  className,
  placeholder = "회의 · 발언 · 참석자 검색…",
  asButton = false,
  shortcut,
  onClick,
  "aria-label": ariaLabel,
  ...props
}: SearchFieldProps) {
  if (asButton) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel ?? (placeholder as string)}
        className={cn(
          base,
          "cursor-pointer focus-visible:border-[color:var(--border-focus)] focus-visible:outline-none focus-visible:[box-shadow:0_0_0_3px_var(--accent-2)]",
          className,
        )}
      >
        <SearchIcon />
        <span className="min-w-0 flex-1 truncate text-left text-base text-[color:var(--text-faint)]">
          {placeholder}
        </span>
        {shortcut}
      </button>
    );
  }

  // A <label> wrapper gives native click-to-focus without JS.
  return (
    <label
      className={cn(
        base,
        "cursor-text focus-within:border-[color:var(--border-focus)] focus-within:bg-card focus-within:[box-shadow:0_0_0_3px_var(--accent-2)]",
        className,
      )}
    >
      <SearchIcon />
      <input
        type="search"
        placeholder={placeholder}
        aria-label={ariaLabel ?? (placeholder as string)}
        className="w-full min-w-0 flex-1 border-0 bg-transparent p-0 font-sans text-base text-foreground outline-none placeholder:text-[color:var(--text-faint)]"
        {...props}
      />
      {shortcut}
    </label>
  );
}

export { SearchField };
