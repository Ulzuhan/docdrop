import type { CSSProperties } from "react";
import { cx } from "@/lib/cx";

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div className={cx("skeleton", className)} style={style} aria-hidden />;
}
