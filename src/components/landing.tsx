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
  // De dónde se pide cuenta, si es que hay dónde. Antes era nuestro flujo de
  // alta escrito a mano: cada despliegue ajeno mostraba un botón hacia el
  // proveedor de identidad de otro. Sin la variable, el botón no existe y la
  // portada solo ofrece entrar — que es lo honesto cuando las altas las
  // gestiona quien opera la instancia por otro canal.
  const enrollUrl = process.env.DOCDROP_ENROLL_URL?.trim() || null;
  return (
    <>
      <SiteHeader
        actions={
          <Button
            variant="ghost"
            size="sm"
            className="h-9"
            render={<Link href="/api/auth/login" prefetch={false}>Sign in</Link>}
          />
        }
      />

      <main className="kc-product-landing flex-1 pb-safe">
        {/* ── Hero ───────────────────────────────────────────────────── */}
        <section className="mx-auto w-full max-w-5xl overflow-x-clip px-4 pt-12 pb-16 sm:px-6 sm:pt-20 sm:pb-24">
          <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
            <div className="text-center lg:text-left">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card/60 px-3 py-1 text-xs text-muted-foreground">
                <ShieldCheck className="size-3.5" aria-hidden />
                Self-hosted · accounts approved by hand
              </span>

              <h1 className="mt-5 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
                Send the whole file.
              </h1>
              <p className="mx-auto mt-5 max-w-xl text-[17px] leading-relaxed text-muted-foreground text-pretty lg:mx-0">
                The video off your GoPro, untouched. No recompressing it into
                mush, no ten-minute upload that dies at 80%, no account needed
                on the other end — just a link that expires when you say so.
              </p>

              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row lg:justify-start">
                {enrollUrl && (
                  <Button size="lg" className="h-12 px-7 text-base" render={<Link href={enrollUrl}>Request an account</Link>} />
                )}
                <Button size="lg" variant="outline" className="h-12 px-7 text-base" render={<Link href="/api/auth/login" prefetch={false}>Sign in</Link>} />
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Got a guest link instead? Open it — it works without an account.
              </p>
              {enrollUrl && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Already have an account elsewhere in this family of services? Use the same button — it asks for access to this one.
                </p>
              )}
            </div>

            <DemoCard />
          </div>
        </section>

        {/* ── Qué lo hace distinto ───────────────────────────────────── */}
        <section className="border-t border-border/60 bg-card/30">
          <div className="mx-auto w-full max-w-3xl px-4 py-14 sm:px-6 sm:py-20">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Why this and not a chat app
            </h2>

            <div className="kc-card-grid mt-8 grid gap-x-10 gap-y-9 sm:grid-cols-2">
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
            render={
              enrollUrl ? (
                <Link href={enrollUrl}>Request an account</Link>
              ) : (
                <Link href="/api/auth/login" prefetch={false}>Sign in</Link>
              )
            }
          />
        </section>
      </main>
    </>
  );
}

/**
 * La pantalla que importa: un archivo grande subido, con su cuenta atrás y su
 * enlace listo para mandar. Enseñar el resultado dice más que describirlo.
 */
function DemoCard() {
  return (
    <div className="relative mx-auto w-full max-w-sm">
      {/* Un resplandor detrás, para que la tarjeta se lea iluminada y no pegada. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-8 -z-10 rounded-[3rem] opacity-70 blur-3xl"
        style={{
          background:
            "radial-gradient(60% 60% at 50% 40%, color-mix(in oklch, var(--primary) 18%, transparent), transparent 70%)",
        }}
      />

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <p className="text-sm font-medium">Active files</p>
          <p className="text-xs tabular-nums text-muted-foreground">6.2 GB / 20 GB</p>
        </div>

        <ul className="divide-y divide-border">
          {DEMO_FILES.map((f) => (
            <li key={f.name} className="flex items-center gap-3 px-5 py-3.5">
              <span aria-hidden className="text-lg">{f.emoji}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{f.name}</p>
                <p className="text-xs tabular-nums text-muted-foreground">
                  {f.size} · {f.left}
                </p>
              </div>
              {f.uploading ? (
                <span className="shrink-0 text-xs tabular-nums text-primary">{f.pct}%</span>
              ) : (
                <span className="shrink-0 rounded-md bg-secondary px-2 py-1 text-[11px] text-muted-foreground">
                  link copied
                </span>
              )}
            </li>
          ))}
        </ul>

        <div className="border-t border-border bg-secondary/30 px-5 py-3.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
            <div className="h-full w-[68%] rounded-full bg-primary" />
          </div>
          <p className="mt-2 text-[11px] tabular-nums text-muted-foreground">
            uploading 4.1 GB of 6.0 GB · resumes if the connection drops
          </p>
        </div>
      </div>
    </div>
  );
}

const DEMO_FILES = [
  { emoji: "🎬", name: "GX010248.MP4", size: "6.0 GB", left: "expires in 2d 14h", uploading: true, pct: 68 },
  { emoji: "🖼", name: "fotos-siargao.zip", size: "218 MB", left: "expires in 22h", uploading: false, pct: 100 },
  { emoji: "📄", name: "contrato-firmado.pdf", size: "1.2 MB", left: "1 download left", uploading: false, pct: 100 },
];

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
