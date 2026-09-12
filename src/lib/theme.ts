/**
 * The theme, kept in the same place and with the same rules as the inline
 * script the server puts in the document: `localStorage.theme` is "dark",
 * "light" or "system", dark is the default, and the resolved value is a class
 * on <html> plus `color-scheme`. That script has already run by the time React
 * mounts, so the first paint is right and this only has to keep in step.
 */
import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";
export type Resolved = "light" | "dark";

const KEY = "theme";
const listeners = new Set<() => void>();
const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

function stored(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" || value === "system" ? value : "dark";
  } catch {
    return "dark";
  }
}

export function resolveTheme(theme: Theme): Resolved {
  if (theme === "system") return media?.matches ? "dark" : "light";
  return theme;
}

function apply() {
  const resolved = resolveTheme(stored());
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
}

function notify() {
  for (const listener of listeners) listener();
}

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  apply();
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onMedia = () => {
    if (stored() === "system") {
      apply();
      listener();
    }
  };
  media?.addEventListener("change", onMedia);
  return () => {
    listeners.delete(listener);
    media?.removeEventListener("change", onMedia);
  };
}

export function useTheme(): { theme: Resolved; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, () => resolveTheme(stored()), () => "dark" as Resolved);
  return {
    theme,
    toggle: () => setTheme(theme === "dark" ? "light" : "dark"),
  };
}
