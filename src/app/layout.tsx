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

export const metadata: Metadata = {
  title: "DocDrop — Share files instantly",
  description: "Upload a file, share the link. It self-destructs.",
  // The service may become reachable from the internet through a temporary tunnel:
  // at least keep it out of search indexes.
  robots: { index: false, follow: false },
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
