import * as React from "react";

import { cn } from "@/shared/lib/utils";

/** Speaker-colored chip — ported from Timbre `core/Tag`. */
function XIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function speakerVars(speaker?: number): React.CSSProperties {
  if (speaker == null) return {};
  const k = ((Number(speaker) - 1) % 8) + 1;
  return {
    "--_bg": `var(--spk-${k}-bg)`,
    "--_fg": `var(--spk-${k}-text)`,
    "--_solid": `var(--spk-${k}-solid)`,
  } as React.CSSProperties;
}

type TagProps = Omit<React.ComponentProps<"span">, "onClick"> & {
  speaker?: number;
  showDot?: boolean;
  onClick?: React.MouseEventHandler<HTMLSpanElement>;
  onRemove?: () => void;
};

function Tag({
  className,
  speaker,
  showDot = true,
  onClick,
  onRemove,
  style,
  children,
  ...props
}: TagProps) {
  const interactive = !!onClick;
  return (
    <span
      data-slot="tag"
      onClick={onClick}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.currentTarget.click();
              }
            }
          : undefined
      }
      className={cn(
        "box-border inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-xs border border-transparent px-2 text-xs font-medium leading-none bg-[var(--_bg,var(--gray-2))] text-[color:var(--_fg,var(--text-secondary))]",
        interactive &&
          "cursor-pointer outline-none transition-[color,background-color,border-color] hover:brightness-[0.97] focus-visible:[box-shadow:var(--focus-ring)]",
        className,
      )}
      style={{ ...speakerVars(speaker), ...style }}
      {...props}
    >
      {showDot && speaker != null && (
        <span
          aria-hidden="true"
          className="size-[7px] shrink-0 rounded-full bg-[var(--_solid,currentColor)]"
        />
      )}
      {children}
      {onRemove && (
        <button
          type="button"
          aria-label="제거"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="-mr-[3px] inline-flex size-[14px] items-center justify-center rounded-xs opacity-60 transition-opacity hover:bg-black/[0.06] hover:opacity-100 [&_svg]:size-[11px]"
        >
          <XIcon />
        </button>
      )}
    </span>
  );
}

export { Tag };
