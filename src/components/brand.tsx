import { useId } from "react";

/**
 * The DocDrop mark: a drop, landing on a line. Ember gradient, a highlight of
 * light on the drop. Drawn inline so it takes the theme's own colours.
 */
export function Mark({ size = 28, className }: { size?: number; className?: string }) {
  const id = useId();
  const gradient = `dd-ember-${id.replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      focusable="false"
    >
      <defs>
        <linearGradient id={gradient} x1="6" y1="4" x2="26" y2="26" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--accent-2)" />
          <stop offset="1" stopColor="var(--accent)" />
        </linearGradient>
      </defs>
      <path
        d="M16 2.5C16 2.5 7.4 11.7 7.4 17.5a8.6 8.6 0 0 0 17.2 0C24.6 11.7 16 2.5 16 2.5Z"
        fill={`url(#${gradient})`}
      />
      <path
        d="M11.9 16.4c.3-2.2 1.4-4.3 3.3-6.2"
        stroke="rgba(255,255,255,.6)"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <rect x="8.5" y="27.4" width="15" height="2.6" rx="1.3" fill="var(--accent)" opacity="0.85" />
    </svg>
  );
}

export function Brand() {
  return (
    <a href="/" className="brand" aria-label="DocDrop home">
      <Mark className="brand-mark" />
      <span className="brand-name">DocDrop</span>
    </a>
  );
}
