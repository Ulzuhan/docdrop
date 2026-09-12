import { useEffect, useState } from "react";

/**
 * A clock in state, ticking every `intervalMs`. Countdowns read this instead
 * of `Date.now()` during render, which keeps render pure and the countdowns
 * moving.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(tick);
  }, [intervalMs]);
  return now;
}
