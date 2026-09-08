import type { AnchorHTMLAttributes } from "react";

/** Navigation is handled by Go; links never prefetch capability URLs. */
export default function Link(props: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props} />;
}
