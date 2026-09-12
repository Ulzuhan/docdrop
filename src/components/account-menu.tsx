import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ExternalLink, LogOut } from "lucide-react";
import { signOut } from "@/lib/api";

/**
 * Who is signed in, where their account lives, and the way out. Signing out
 * goes through the provider's own end-session page: clearing the cookie here
 * alone would let "Sign in" walk straight back in without asking.
 */
export function AccountMenu({ email, accountUrl }: { email: string; accountUrl: string | null }) {
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const shown = email.split("@")[0] || email;

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(root.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(current + step + items.length) % items.length]?.focus();
  }

  async function leave() {
    setLeaving(true);
    window.location.href = await signOut();
  }

  return (
    <div className="menu-root" ref={root}>
      <button
        type="button"
        className="menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="avatar" aria-hidden>
          {shown.slice(0, 1).toUpperCase()}
        </span>
        <span className="who">{shown}</span>
        <ChevronDown aria-hidden />
      </button>

      {open && (
        <div role="menu" className="menu" onKeyDown={onMenuKey}>
          <div className="menu-id">
            <p className="name">{shown}</p>
            <p className="email" title={email}>
              {email}
            </p>
          </div>
          <div className="menu-sep" />
          {accountUrl && (
            <a role="menuitem" className="menu-item" href={accountUrl} target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden />
              Your account
            </a>
          )}
          <button role="menuitem" type="button" className="menu-item" onClick={leave} disabled={leaving}>
            <LogOut aria-hidden />
            {leaving ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}
