"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { FileUp, LinkIcon, Loader2 } from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import { Skeleton } from "@/components/ui/skeleton";
import { UploadQueue, useUploadQueue } from "@/components/upload-queue";
import { EncryptionChoice } from "@/components/encryption-choice";
import { formatRemaining } from "@/lib/format";
import { GUEST_UPLOAD_TTL_HOURS } from "@/lib/guest-shared";

interface LinkInfo {
  label: string | null;
  expiresAt: number;
}

/**
 * Guest upload page: /guest/<token>.
 *
 * Whoever holds the link uploads here without the dashboard password. On purpose
 * it shows nothing but its own queue — no listing, no storage gauge, nothing that
 * says what else lives on the server.
 */
export default function GuestPage() {
  const params = useParams();
  const token = params.token as string;

  const [link, setLink] = useState<LinkInfo | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const [encrypt, setEncrypt] = useState(true);
  const { items, enqueue, cancel, clearFinished } = useUploadQueue({
    ttlHours: GUEST_UPLOAD_TTL_HOURS,
    maxDownloads: 0,
    encrypt,
    onCompleted: () => {},
    headers: { "x-docdrop-guest": token },
    // Mid-upload expiry or revocation: the guest gets told, not bounced to a
    // login they have no password for.
    onUnauthorized: () => setInvalid(true),
  });

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/guest/${token}`);
        if (cancelled) return;
        if (!res.ok) {
          setInvalid(true);
          return;
        }
        setLink(await res.json());
      } catch {
        if (!cancelled) setInvalid(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // The link may expire while the tab sits open.
  const expired = link !== null && link.expiresAt < now;

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pt-8 pb-safe sm:px-6 sm:pt-12">
        {loading ? (
          <Skeleton className="h-64 w-full rounded-2xl" />
        ) : invalid || expired ? (
          <div className="rounded-2xl border border-border bg-card/70 p-8 text-center sm:p-10">
            <span
              aria-hidden
              className="mx-auto grid size-14 place-items-center rounded-2xl bg-muted text-muted-foreground"
            >
              <LinkIcon className="size-6" />
            </span>
            <h1 className="mt-4 text-xl font-semibold tracking-tight">
              This guest link is no longer valid
            </h1>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground text-balance">
              It expired or was revoked. Ask whoever sent it to you for a new one.
            </p>
          </div>
        ) : (
          <>
            <div className="mb-8 text-center sm:mb-10">
              <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
                {link?.label ? `Send your files, ${link.label}` : "Send your files"}
              </h1>
              <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground text-balance sm:text-base">
                Whatever you upload here lands safely on the other side.
                {link && (
                  <>
                    {" "}
                    This link works for another {formatRemaining(link.expiresAt, now)}.
                  </>
                )}
              </p>
            </div>

            <section aria-label="Upload files">
              <div
                onDragEnter={(e) => {
                  e.preventDefault();
                  dragDepth.current += 1;
                  setIsDragging(true);
                }}
                onDragOver={(e) => e.preventDefault()}
                onDragLeave={(e) => {
                  e.preventDefault();
                  dragDepth.current -= 1;
                  if (dragDepth.current <= 0) setIsDragging(false);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  dragDepth.current = 0;
                  setIsDragging(false);
                  const dropped = Array.from(e.dataTransfer.files);
                  if (dropped.length > 0) enqueue(dropped);
                }}
                className={`relative overflow-hidden rounded-2xl border-2 border-dashed transition-all duration-200 ${
                  isDragging
                    ? "border-primary bg-primary/10 shadow-lg shadow-primary/10 sm:scale-[1.01]"
                    : "border-border bg-card/40 hover:border-primary/50 hover:bg-card/70"
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="sr-only"
                  onChange={(e) => {
                    enqueue(Array.from(e.target.files ?? []));
                    e.target.value = "";
                  }}
                />

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex w-full flex-col items-center gap-3 px-6 py-10 text-center outline-none focus-visible:ring-2 focus-visible:ring-ring sm:py-14"
                >
                  <span
                    aria-hidden
                    className="grid size-14 place-items-center rounded-2xl bg-primary/12 text-primary ring-1 ring-primary/20 sm:size-16"
                  >
                    <FileUp className="size-6 sm:size-7" />
                  </span>
                  <span className="text-base font-medium sm:text-lg">
                    Tap to choose files
                  </span>
                  <span className="text-sm text-muted-foreground">
                    <span className="hidden sm:inline">or drag them here · </span>
                    several at once · up to 10 GB each
                  </span>
                </button>
              </div>

              <div className="mx-auto mt-4 max-w-sm">
                <EncryptionChoice value={encrypt} onChange={setEncrypt} />
              </div>

              <div className="mt-4 flex items-center justify-center gap-2">
                {items.some((i) => i.state === "uploading") && (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    keep this tab open until it finishes
                  </span>
                )}
              </div>

              <UploadQueue items={items} onCancel={cancel} onClearFinished={clearFinished} modoInvitado />
            </section>
          </>
        )}
      </main>
    </>
  );
}
