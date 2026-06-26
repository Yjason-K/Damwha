import * as React from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/lib/utils";

/**
 * Tabs — Radix Tabs (radix-ui) re-skinned with Timbre tokens.
 * `variant` on TabsList: "underline" (default) or "pill". Radix provides
 * roving tabindex, arrow-key nav, and aria-selected. The active style is
 * driven by the list's data-variant via a named group.
 */

const tabsListVariants = cva("group/tablist inline-flex items-center", {
  variants: {
    variant: {
      underline: "gap-0.5 border-b border-[color:var(--border-subtle)]",
      pill: "gap-[3px] rounded-sm bg-[var(--gray-2)] p-[3px]",
    },
  },
  defaultVariants: { variant: "underline" },
});

const triggerClasses =
  "relative inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-xs px-2.5 py-2 text-sm font-medium text-[color:var(--text-muted)] outline-none transition-colors duration-[80ms] hover:text-foreground focus-visible:[box-shadow:var(--focus-ring)] disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-foreground [&_svg]:size-4 [&_svg]:shrink-0 group-data-[variant=underline]/tablist:-mb-px group-data-[variant=underline]/tablist:data-[state=active]:[box-shadow:inset_0_-2px_0_var(--accent-solid)] group-data-[variant=pill]/tablist:data-[state=active]:bg-card group-data-[variant=pill]/tablist:data-[state=active]:[box-shadow:var(--shadow-xs)]";

function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  );
}

function TabsList({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant ?? "underline"}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(triggerClasses, className)}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn(
        "mt-1 text-sm text-[color:var(--text-secondary)] outline-none focus-visible:[box-shadow:var(--focus-ring)]",
        className,
      )}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
