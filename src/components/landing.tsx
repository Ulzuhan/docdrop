import Link from "next/link";
import { Clock, FileUp, Flame, Link2, ShieldCheck, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteHeader } from "@/components/site-header";

/**
 * What somebody without a session sees.
 *
 * Server-rendered with no client JavaScript: it is the first thing a stranger
 * loads, usually from a link on a phone, and nothing here needs hydrating to
 * be useful.
 */
export function Landing() {
  return (
    <>
      <SiteHeader
        actions={
          <Button
            variant="ghost"
            size="sm"
            className="h-9"
            render={<Link href="/api/auth/login">Sign in</Link>}
          />
        }
      />

      <main className="flex-1 pb-safe">
        {/* ── Hero ───────────────────────────────────────────────────── */}
        <section className="mx-auto w-full max-w-3xl px-4 pt-12 pb-14 text-center sm:px-6 sm:pt-20 sm:pb-20">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card/60 px-3 py-1 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5" aria-hidden />
            Self-hosted · accounts approved by hand
          </span>

          <h1 className="mt-5 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Send the whole file.
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-[17px] leading-relaxed text-muted-foreground text-pretty">
            The video off your GoPro, untouched. No recompressing it into mush,
            no ten-minute upload that dies at 80%, no account needed on the
            other end — just a link that expires when you say so.
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button size="lg" className="h-12 px-7 text-base" render={<Link href="/api/auth/login">Sign in to upload</Link>} />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Got a guest link instead? Open it — it works without an account.
          </p>
        </section>

        {/* ── Qué lo hace distinto ───────────────────────────────────── */}
        <section className="border-t border-border/60 bg-card/30">
          <div className="mx-auto w-full max-w-3xl px-4 py-14 sm:px-6 sm:py-20">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Why this and not a chat app
            </h2>

            <div className="mt-8 grid gap-x-10 gap-y-9 sm:grid-cols-2">
              {FEATURES.map(({ Icon, title, body }) => (
                <div key={title}>
                  <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Icon className="size-[18px]" aria-hidden />
                  </div>
                  <h3 className="mt-3.5 font-medium">{title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                    {body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Cierre ─────────────────────────────────────────────────── */}
        <section className="mx-auto w-full max-w-3xl px-4 py-14 text-center sm:px-6 sm:py-20">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Nothing sits here forever
          </h2>
          <p className="mx-auto mt-3 max-w-md text-[15px] leading-relaxed text-muted-foreground text-pretty">
            Every file carries its own expiry, and a download limit if you want
            one. When it runs out it is deleted — not archived, not backed up
            somewhere else.
          </p>
          <Button
            size="lg"
            className="mt-7 h-12 px-7 text-base"
            render={<Link href="/api/auth/login">Sign in</Link>}
          />
        </section>
      </main>
    </>
  );
}

const FEATURES = [
  {
    Icon: FileUp,
    title: "Files up to 10 GB",
    body: "Sent in chunks, so a dropped connection resumes where it stopped instead of starting over.",
  },
  {
    Icon: Smartphone,
    title: "Survives a phone",
    body: "Keeps the screen awake while it uploads, and picks the same file back up if the tab closes.",
  },
  {
    Icon: Flame,
    title: "Self-destructing",
    body: "One hour to a month, and an optional download limit. After that the content is gone.",
  },
  {
    Icon: Link2,
    title: "Share with a link",
    body: "Whoever receives it needs no account and installs nothing. The link is the permission.",
  },
  {
    Icon: Clock,
    title: "Guest links to receive",
    body: "Need something sent to you? Hand out a temporary link that only lets the other person upload.",
  },
  {
    Icon: ShieldCheck,
    title: "Nobody wandering in",
    body: "Accounts are approved one by one, and the listing is only visible to people who have one.",
  },
];
