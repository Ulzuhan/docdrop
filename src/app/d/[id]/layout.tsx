import type { Metadata } from "next";

/**
 * A download page must never reach a search index.
 *
 * The identifier in the URL *is* the credential — 72 random bits that anyone
 * holding can use — so a crawler that finds one and publishes it hands the file
 * to the world. The whole app used to carry `noindex` for this reason, which
 * also kept the public landing out of every index; the flag belongs here, on
 * the pages that carry a secret in their path, and nowhere else.
 *
 * It lives in a layout because the page itself is a client component, and those
 * cannot export metadata.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function DownloadLayout({ children }: { children: React.ReactNode }) {
  return children;
}
