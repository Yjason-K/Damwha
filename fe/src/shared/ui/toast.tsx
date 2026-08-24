import * as React from "react";
import { Toast as ToastPrimitive } from "radix-ui";

import { cn } from "@/shared/lib/utils";

/**
 * Toast primitives — Radix Toast (radix-ui) re-skinned with Timbre tokens
 * (dark --gray-12 surface). Radix handles aria-live announcements, swipe,
 * and auto-dismiss. Use together with `Toaster` + `toast()` (see toaster.tsx
 * / use-toast.ts) for imperative toasts.
 */

function ToastProvider(
  props: React.ComponentProps<typeof ToastPrimitive.Provider>,
) {
  return <ToastPrimitive.Provider {...props} />;
}

function ToastViewport({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Viewport>) {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={cn(
        "fixed right-0 bottom-0 z-[120] m-0 flex max-h-screen w-full list-none flex-col gap-2 p-6 outline-none sm:max-w-[400px]",
        className,
      )}
      {...props}
    />
  );
}

function Toast({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Root>) {
  return (
    <ToastPrimitive.Root
      data-slot="toast"
      className={cn(
        "relative box-border flex min-w-[280px] items-start gap-2.5 rounded-md bg-[var(--gray-12)] p-3.5 text-[color:var(--gray-1)] [box-shadow:var(--shadow-lg)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-right-5 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[swipe=end]:animate-out data-[swipe=end]:fade-out-0 data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:transition-transform",
        className,
      )}
      {...props}
    />
  );
}

function ToastTitle({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Title>) {
  return (
    <ToastPrimitive.Title
      data-slot="toast-title"
      className={cn("text-sm font-medium", className)}
      {...props}
    />
  );
}

function ToastDescription({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Description>) {
  return (
    <ToastPrimitive.Description
      data-slot="toast-description"
      className={cn(
        "mt-0.5 text-xs leading-[1.45] text-[color:var(--gray-7)]",
        className,
      )}
      {...props}
    />
  );
}

function ToastAction({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Action>) {
  return (
    <ToastPrimitive.Action
      data-slot="toast-action"
      className={cn(
        "shrink-0 cursor-pointer rounded-xs px-1 py-0.5 text-xs font-semibold text-[color:var(--accent-6)] outline-none transition-colors hover:text-white focus-visible:[box-shadow:var(--focus-ring)]",
        className,
      )}
      {...props}
    />
  );
}

function ToastClose({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Close>) {
  return (
    <ToastPrimitive.Close
      data-slot="toast-close"
      aria-label="닫기"
      className={cn(
        "shrink-0 cursor-pointer rounded-xs text-[color:var(--gray-7)] outline-none transition-colors hover:text-white focus-visible:[box-shadow:var(--focus-ring)] [&_svg]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

export {
  Toast,
  ToastAction,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
};
