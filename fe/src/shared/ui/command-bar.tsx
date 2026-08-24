import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { cn } from "@/shared/lib/utils";
import { Kbd } from "@/shared/ui/kbd";

/**
 * CommandBar — ⌘K command palette ported from Timbre `meeting/CommandBar`.
 * Backed by Radix Dialog (focus trap, ESC, aria-modal, focus return) with a
 * proper combobox + listbox: the input keeps focus while ↑/↓ move the active
 * option via aria-activedescendant, Enter selects.
 */

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

export type CommandItem = {
  id?: string;
  icon?: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  trail?: React.ReactNode;
};

export type CommandGroup = {
  label: React.ReactNode;
  items: CommandItem[];
};

type CommandBarProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query?: string;
  onQueryChange?: (query: string) => void;
  placeholder?: string;
  facets?: React.ReactNode;
  groups?: CommandGroup[];
  onSelect?: (item: CommandItem) => void;
};

function CommandBar({
  open,
  onOpenChange,
  query = "",
  onQueryChange,
  placeholder = "회의 · 발언 · 참석자 검색…",
  facets,
  groups = [],
  onSelect,
}: CommandBarProps) {
  const reactId = React.useId();
  const listId = `${reactId}-list`;
  const flat = React.useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // Reset the active option when the query changes (adjust-state-on-prop-change
  // during render — avoids a setState-in-effect).
  const [active, setActive] = React.useState(0);
  const [seenQuery, setSeenQuery] = React.useState(query);
  if (query !== seenQuery) {
    setSeenQuery(query);
    setActive(0);
  }
  const activeIndex = flat.length ? Math.min(active, flat.length - 1) : 0;

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(flat.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = flat[activeIndex];
      if (item) onSelect?.(item);
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[120] bg-[rgba(20,23,28,0.28)] backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content
          className="fixed top-[12vh] left-1/2 z-[120] flex max-h-[60vh] w-[calc(100%-2rem)] max-w-[560px] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-border bg-card text-foreground outline-none [box-shadow:var(--shadow-lg)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          aria-label="명령 팔레트"
        >
          <DialogPrimitive.Title className="sr-only">
            명령 팔레트
          </DialogPrimitive.Title>

          <div className="flex items-center gap-2.5 border-b border-[color:var(--border-subtle)] px-3.5 py-3">
            <span className="inline-flex shrink-0 text-[color:var(--text-muted)] [&_svg]:size-[17px]">
              <SearchIcon />
            </span>
            <input
              type="text"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={
                flat.length ? `${listId}-opt-${activeIndex}` : undefined
              }
              value={query}
              placeholder={placeholder}
              onChange={(e) => onQueryChange?.(e.target.value)}
              onKeyDown={onInputKeyDown}
              className="text-h2 min-w-0 flex-1 border-0 bg-transparent p-0 font-sans tracking-[-0.008em] text-foreground outline-none placeholder:text-[color:var(--text-faint)]"
            />
          </div>

          {facets && (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-[color:var(--border-subtle)] px-3.5 py-2.5">
              <span className="mr-0.5 font-mono text-2xs tracking-[var(--tracking-wide)] text-[color:var(--text-faint)] uppercase">
                필터
              </span>
              {facets}
            </div>
          )}

          <div id={listId} role="listbox" className="overflow-auto p-1.5">
            {flat.length === 0 && (
              <div className="px-3.5 py-7 text-center text-sm text-[color:var(--text-muted)]">
                결과가 없어요. 다른 검색어를 시도해 보세요.
              </div>
            )}
            {groups.map(
              (g, gi) =>
                g.items.length > 0 && (
                  <div key={gi}>
                    <div className="px-2 pt-2.5 pb-1 text-2xs font-semibold tracking-[var(--tracking-wide)] text-[color:var(--text-faint)] uppercase">
                      {g.label}
                    </div>
                    {g.items.map((item, ii) => {
                      const i =
                        groups
                          .slice(0, gi)
                          .reduce((n, gg) => n + gg.items.length, 0) + ii;
                      const isActive = i === activeIndex;
                      return (
                        <div
                          key={item.id ?? ii}
                          id={`${listId}-opt-${i}`}
                          role="option"
                          aria-selected={isActive}
                          onMouseMove={() => setActive(i)}
                          onClick={() => onSelect?.(item)}
                          className={cn(
                            "flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-2",
                            isActive && "bg-[var(--surface-active)]",
                          )}
                        >
                          {item.icon && (
                            <span
                              className={cn(
                                "inline-flex w-[18px] shrink-0 justify-center [&_svg]:size-4",
                                isActive
                                  ? "text-[color:var(--accent-text)]"
                                  : "text-[color:var(--text-muted)]",
                              )}
                            >
                              {item.icon}
                            </span>
                          )}
                          <span className="min-w-0 flex-1">
                            <span
                              className={cn(
                                "block truncate text-base text-foreground",
                                isActive &&
                                  "font-medium text-[color:var(--accent-text)]",
                              )}
                            >
                              {item.title}
                            </span>
                            {item.meta && (
                              <span className="mt-px block truncate text-xs text-[color:var(--text-muted)]">
                                {item.meta}
                              </span>
                            )}
                          </span>
                          {item.trail && (
                            <span className="shrink-0 font-mono text-2xs tracking-[var(--tracking-mono)] text-[color:var(--text-faint)]">
                              {item.trail}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ),
            )}
          </div>

          <div className="flex items-center gap-3.5 border-t border-[color:var(--border-subtle)] bg-[var(--gray-1)] px-3.5 py-2.5 text-2xs text-[color:var(--text-muted)]">
            <span className="inline-flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> 이동
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd>↵</Kbd> 열기
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd>esc</Kbd> 닫기
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export { CommandBar };
