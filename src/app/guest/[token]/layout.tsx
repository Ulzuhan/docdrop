import type { Metadata } from "next";

/**
 * A guest upload link must never reach a search index: the token in the path is
 * what grants the upload, so an indexed one is an open door with a countdown.
 *
 * It lives in a layout because the page itself is a client component, and those
 * cannot export metadata.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function GuestLayout({ children }: { children: React.ReactNode }) {
  return children;
}
