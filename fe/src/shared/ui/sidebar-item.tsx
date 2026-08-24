import * as React from "react";

import { cn } from "@/shared/lib/utils";

/**
 * SidebarItem — ported from Timbre `navigation/SidebarItem`.
 * Prop-driven content (icon / label / sub / meta / count) with an active
 * state (accent fill + left bar). Renders a <button> by default; pass
 * `asChild` with a single element child (e.g. a react-router <Link>) to
 * render that element instead while keeping the built content. `active`
 * sets aria-current="page".
 */

const baseClass =
  "relative box-border flex w-full cursor-pointer items-center gap-[9px] rounded-sm px-2 py-1.5 text-left text-[color:var(--text-secondary)] no-underline outline-none transition-colors duration-[80ms] hover:bg-accent hover:text-foreground focus-visible:[box-shadow:var(--focus-ring)]";

const activeClass =
  "bg-[var(--surface-active)] text-[color:var(--accent-text)] hover:bg-[var(--surface-active)] hover:text-[color:var(--accent-text)] before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-[var(--accent-solid)] before:content-['']";

type SidebarItemProps = Omit<React.ComponentProps<"button">, "children"> & {
  icon?: React.ReactNode;
  label: React.ReactNode;
  sub?: React.ReactNode;
  meta?: React.ReactNode;
  count?: number | string;
  active?: boolean;
  indent?: number;
  asChild?: boolean;
  children?: React.ReactElement;
};

function SidebarItem({
  className,
  icon,
  label,
  sub,
  meta,
  count,
  active = false,
  indent = 0,
  asChild = false,
  children,
  style,
  ...rest
}: SidebarItemProps) {
  const classes = cn(baseClass, active && activeClass, className);
  const mergedStyle: React.CSSProperties | undefined = indent
    ? { paddingLeft: 8 + indent * 16, ...style }
    : style;

  const inner = (
    <>
      {icon && (
        <span
          className={cn(
            "inline-flex shrink-0 [&_svg]:size-4",
            active
              ? "text-[color:var(--accent-text)]"
              : "text-[color:var(--text-muted)]",
          )}
        >
          {icon}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="truncate text-sm font-medium">{label}</span>
        {sub && (
          <span
            className={cn(
              "truncate text-xs",
              active
                ? "text-[color:var(--accent-text)] opacity-75"
                : "text-[color:var(--text-faint)]",
            )}
          >
            {sub}
          </span>
        )}
      </span>
      {meta != null && (
        <span className="shrink-0 font-mono text-2xs tracking-[var(--tracking-mono)] text-[color:var(--text-faint)]">
          {meta}
        </span>
      )}
      {count != null && (
        <span
          className={cn(
            "min-w-[18px] shrink-0 rounded-xs px-[5px] py-px text-center text-2xs font-medium",
            active
              ? "bg-[var(--accent-3)] text-[color:var(--accent-text)]"
              : "bg-[var(--gray-3)] text-[color:var(--text-muted)]",
          )}
        >
          {count}
        </span>
      )}
    </>
  );

  if (asChild && React.isValidElement(children)) {
    const child = children as React.ReactElement<Record<string, unknown>>;
    const childProps = child.props as {
      className?: string;
      style?: React.CSSProperties;
    };
    return React.cloneElement(
      child,
      {
        className: cn(classes, childProps.className),
        style: { ...mergedStyle, ...childProps.style },
        "aria-current": active ? "page" : undefined,
      } as Record<string, unknown>,
      inner,
    );
  }

  return (
    <button
      data-slot="sidebar-item"
      type="button"
      className={classes}
      style={mergedStyle}
      aria-current={active ? "page" : undefined}
      {...rest}
    >
      {inner}
    </button>
  );
}

export { SidebarItem };
