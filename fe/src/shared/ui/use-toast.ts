import * as React from "react";

/**
 * Minimal imperative toast store for the Radix-based Toast UI.
 * Call `toast({...})` from anywhere; render <Toaster /> once near the app
 * root to display the queue. Subscribed via useSyncExternalStore.
 */

export type ToastVariant = "info" | "success" | "error";

export type ToastInput = {
  title?: React.ReactNode;
  description?: React.ReactNode;
  variant?: ToastVariant;
  duration?: number;
  action?: { label: string; onClick: () => void };
};

export type ToastRecord = ToastInput & { id: string };

let counter = 0;
const genId = () => `toast-${++counter}`;

let store: ToastRecord[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getSnapshot() {
  return store;
}

export function toast(input: ToastInput): string {
  const id = genId();
  store = [{ id, variant: "info", ...input }, ...store];
  emit();
  return id;
}

export function dismissToast(id: string) {
  store = store.filter((t) => t.id !== id);
  emit();
}

export function useToast() {
  const toasts = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { toasts, toast, dismiss: dismissToast };
}
