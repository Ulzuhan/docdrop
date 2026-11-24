import { useEffect, useState } from "react";

export type LandingSessionState =
  | { kind: "continue"; name: string }
  | { kind: "pending" | "requestable" | "invite_only"; name: string; accountUrl: string };

const SIGNED_OUT_KEY = "kc_signed_out";
const ATTEMPTED_KEY = "kc_sso_attempted";
const COOLDOWN_MS = 60_000;

function readStorage(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // ignore storage errors
  }
}

export function clearLandingSessionSuppression(): void {
  try {
    window.sessionStorage.removeItem(SIGNED_OUT_KEY);
    window.sessionStorage.removeItem(ATTEMPTED_KEY);
  } catch {
    // ignore storage errors
  }
}

export function useLandingSession(
  sessionUrl: string | null,
  loginHref: string
): LandingSessionState | null {
  const [state, setState] = useState<LandingSessionState | null>(null);

  useEffect(() => {
    if (!sessionUrl) return;
    let cancelled = false;

    const url = new URL(window.location.href);
    if (url.searchParams.get("signed_out") === "1") {
      writeStorage(SIGNED_OUT_KEY, "1");
      url.searchParams.delete("signed_out");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }

    const signinError = url.searchParams.has("error");
    const attemptedAt = Number(readStorage(ATTEMPTED_KEY) || "0");
    const suppressed =
      signinError ||
      readStorage(SIGNED_OUT_KEY) === "1" ||
      (Number.isFinite(attemptedAt) && attemptedAt > 0 && Date.now() - attemptedAt < COOLDOWN_MS);

    const signal =
      typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(4000)
        : undefined;

    fetch(sessionUrl, { credentials: "include", cache: "no-store", signal })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          s: {
            signed_in?: boolean;
            name?: string;
            tool_access?: string;
            account_url?: string;
          } | null
        ) => {
          if (cancelled || !s?.signed_in) return;
          const name = String(s.name || "account").slice(0, 40);
          const accountUrl =
            typeof s.account_url === "string" && s.account_url
              ? s.account_url
              : new URL("/", sessionUrl).toString();

          if (s.tool_access === "granted") {
            if (!suppressed) {
              writeStorage(ATTEMPTED_KEY, String(Date.now()));
              window.location.replace(loginHref);
              return;
            }
            setState({ kind: "continue", name });
            return;
          }

          if (
            s.tool_access === "pending" ||
            s.tool_access === "requestable" ||
            s.tool_access === "invite_only"
          ) {
            setState({ kind: s.tool_access, name, accountUrl });
          }
        }
      )
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [sessionUrl, loginHref]);

  return state;
}
