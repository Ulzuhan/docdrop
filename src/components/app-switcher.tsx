import { useEffect, useRef, useState } from "react";

const SWITCHER_ID = "kc-app-switcher";

const SERVICES = [
  { name: "TabUp", url: "https://tabup.kaicorplabs.com", slug: "tabup", desc: "Shared expenses" },
  { name: "QR-Forge", url: "https://qr.kaicorplabs.com", slug: "qr-forge", desc: "Dynamic QR codes" },
  { name: "DocDrop", url: "https://docdrop.kaicorplabs.com", slug: "docdrop", desc: "Encrypted file drops" },
  { name: "SecretDrop", url: "https://secret.kaicorplabs.com", slug: "secretdrop", desc: "One-time secrets" },
  { name: "Pixelforge", url: "https://pixel.kaicorplabs.com", slug: "pixelforge", desc: "Image tools" },
  { name: "LinkUp", url: "https://link.kaicorplabs.com", slug: "linkup", desc: "Privacy short links" },
];

export function AppSwitcher({
  current = "docdrop",
  signedIn = false,
}: {
  current?: string;
  signedIn?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const onToggle = (event: Event) => {
      const state = (event as Event & { newState?: string }).newState;
      setOpen(state === "open");
    };
    panel.addEventListener("toggle", onToggle);
    return () => panel.removeEventListener("toggle", onToggle);
  }, []);

  const handleFallbackClick = () => {
    if (typeof HTMLElement === "undefined" || Object.hasOwn(HTMLElement.prototype, "popover")) {
      return;
    }
    const panel = panelRef.current;
    if (!panel) return;
    const nextOpen = !panel.classList.contains(":popover-open");
    panel.classList.toggle(":popover-open", nextOpen);
    setOpen(nextOpen);
  };

  return (
    <>
      <button
        type="button"
        className="kc-switcher-btn"
        {...({ popoverTarget: SWITCHER_ID, popoverTargetAction: "toggle" } as Record<string, string>)}
        aria-controls={SWITCHER_ID}
        aria-expanded={open}
        aria-label="KaiCorp Labs apps"
        title="KaiCorp Labs apps"
        onClick={handleFallbackClick}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
          <rect x="4" y="4" width="4" height="4" rx="1" />
          <rect x="10" y="4" width="4" height="4" rx="1" />
          <rect x="16" y="4" width="4" height="4" rx="1" />
          <rect x="4" y="10" width="4" height="4" rx="1" />
          <rect x="10" y="10" width="4" height="4" rx="1" />
          <rect x="16" y="10" width="4" height="4" rx="1" />
          <rect x="4" y="16" width="4" height="4" rx="1" />
          <rect x="10" y="16" width="4" height="4" rx="1" />
          <rect x="16" y="16" width="4" height="4" rx="1" />
        </svg>
      </button>
      <nav
        ref={panelRef}
        id={SWITCHER_ID}
        {...({ popover: "auto" } as Record<string, string>)}
        className="kc-switcher-panel"
        aria-label="KaiCorp Labs apps"
      >
        <p className="kc-switcher-title">KaiCorp Labs</p>
        <ul className="kc-switcher-list">
          {SERVICES.map((s) => {
            const isCurrent = s.slug === current;
            const href = signedIn && !isCurrent ? `${s.url}/?sso=1` : s.url;
            return (
              <li key={s.slug}>
                <a
                  href={href}
                  aria-current={isCurrent ? "page" : undefined}
                  className="kc-switcher-link"
                >
                  <span className="kc-switcher-meta">
                    <span>{s.name}</span>
                    <span className="kc-switcher-desc">{s.desc}</span>
                  </span>
                  {isCurrent && <span className="kc-switcher-badge">Current</span>}
                </a>
              </li>
            );
          })}
        </ul>
        <hr className="kc-switcher-sep" />
        <div className="kc-switcher-foot">
          <a href="https://account.kaicorplabs.com/" className="kc-switcher-link">
            Your account
          </a>
          <a href="https://kaicorplabs.com/" className="kc-switcher-link">
            kaicorplabs.com
          </a>
        </div>
      </nav>
    </>
  );
}
