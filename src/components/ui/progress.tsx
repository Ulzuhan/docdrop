import { cx } from "@/lib/cx";

interface Props {
  /** 0..100 */
  value: number;
  /** Adds the moving sheen while bytes are flowing. */
  live?: boolean;
  indeterminate?: boolean;
  tone?: "ok" | "ice";
  size?: "sm" | "md";
  label?: string;
  className?: string;
}

export function Progress({ value, live, indeterminate, tone, size = "md", label, className }: Props) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      className={cx("progress", size === "sm" && "progress-sm", className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
      data-live={live || undefined}
      data-indeterminate={indeterminate || undefined}
      data-tone={tone}
    >
      <div className="progress-bar" style={indeterminate ? undefined : { width: `${pct}%` }} />
    </div>
  );
}
