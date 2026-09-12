import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from "react";
import { cx } from "@/lib/cx";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger" | "ice";
export type ButtonSize = "sm" | "md" | "lg" | "icon" | "icon-sm" | "icon-lg";

interface Styling {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  className?: string;
}

function classes({ variant = "secondary", size = "md", block, className }: Styling): string {
  return cx("btn", `btn-${variant}`, size !== "md" && `btn-${size}`, block && "btn-block", className);
}

export function Button({
  variant,
  size,
  block,
  className,
  type = "button",
  ...rest
}: Styling & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={classes({ variant, size, block, className })} {...rest} />;
}

/** An anchor dressed as a button: navigation stays navigation. */
export function LinkButton({
  variant,
  size,
  block,
  className,
  ...rest
}: Styling & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a className={classes({ variant, size, block, className })} {...rest} />;
}
