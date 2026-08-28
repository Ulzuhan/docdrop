import { KaiCorpFooter } from "@/components/kaicorp-footer";
import type { Metadata, Viewport } from "next";
import { Space_Grotesk, Inter, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { headers } from "next/headers";
import { ServiceWorkerRegistration } from "@/components/service-worker";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const display = Space_Grotesk({ variable: "--font-display", weight: ["500", "700"], subsets: ["latin"] });
const sans = Inter({ variable: "--font-sans", weight: ["400", "500"], subsets: ["latin"] });
const mono = JetBrains_Mono({ variable: "--font-mono", weight: ["400", "500"], subsets: ["latin"] });

/**
 * The public origin, for canonical and social previews.
 *
 * It comes from DOCDROP_PUBLIC_HOST, which already exists for the origin check:
 * no new variable, and whoever deploys this on their own domain gets their own
 * canonical without touching code. Unset, none is emitted — Next would resolve
 * relative URLs against localhost, and a canonical pointing there is worse than
 * no canonical at all.
 */
const publicHost = process.env.DOCDROP_PUBLIC_HOST?.trim();
const base = publicHost ? new URL(`https://${publicHost}`) : undefined;

const TITLE = "DocDrop — send the whole file, then let it disappear";
const DESCRIPTION =
  "Multi-gigabyte transfers with nothing recompressed: uploads resume after a dropped connection, and links delete themselves when you say so. Self-hosted and open source.";

/**
 * `noindex` used to sit here, on the whole application, back when the service
 * was reachable through a temporary tunnel. It kept the public landing out of
 * every index too. The flag now lives where it belongs — on `/d/[id]` and
 * `/guest/[token]`, whose URLs carry a credential — and this page, which
 * explains the product to strangers, is indexable.
 */
export const metadata: Metadata = {
  ...(base ? { metadataBase: base, alternates: { canonical: "/" } } : {}),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
    siteName: "DocDrop",
    locale: "en_US",
    ...(base ? { url: "/", images: [{ url: "/og.jpg", width: 760, height: 475, alt: "DocDrop: large files uploading, each with its expiry" }] } : {}),
  },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Zoom is not blocked: preventing it is an accessibility barrier.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfbfe" },
    { media: "(prefers-color-scheme: dark)", color: "#16161f" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // El nonce de esta petición, puesto por src/proxy.ts. Se lo lleva next-themes,
  // cuyo script anti-parpadeo es el único en línea que Next no marca solo.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${display.variable} ${sans.variable} ${mono.variable}`}
    >
      <body className="min-h-dvh flex flex-col">
        <ThemeProvider nonce={nonce}>
          {children}
          <KaiCorpFooter current="docdrop" />
          <Toaster position="top-center" richColors closeButton />
          <ServiceWorkerRegistration />
        </ThemeProvider>
      </body>
    </html>
  );
}
