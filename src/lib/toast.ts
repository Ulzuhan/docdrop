/**
 * A small toast store. Errors stay longer than confirmations; anything can be
 * dismissed by hand. `<Toaster>` renders whatever is here.
 */
import { useSyncExternalStore } from "react";

export type ToastKind = "success" | "error" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
}

let toasts: Toast[] = [];
let sequence = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function push(kind: ToastKind, title: string, description?: string): number {
  const id = ++sequence;
  toasts = [...toasts, { id, kind, title, description }];
  emit();
  setTimeout(() => dismiss(id), kind === "error" ? 8000 : 4000);
  return id;
}

export function dismiss(id: number) {
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  success: (title: string, description?: string) => push("success", title, description),
  error: (title: string, description?: string) => push("error", title, description),
  info: (title: string, description?: string) => push("info", title, description),
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, () => toasts, () => toasts);
}
