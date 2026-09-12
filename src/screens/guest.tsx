import { useCallback, useEffect, useMemo, useState } from "react";
import { Link2Off, ShieldCheck } from "lucide-react";
import { Header } from "@/components/header";
import { Dropzone, DropOverlay } from "@/components/dropzone";
import { Skeleton } from "@/components/ui/skeleton";
import { FileIcon } from "@/components/file-icon";
import { EncryptionChoice } from "@/components/upload-options";
import { UploadQueue } from "@/components/upload-queue";
import { fetchGuestInfo, type GuestInfo } from "@/lib/api";
import { usePasteFiles, useWindowDrop } from "@/lib/dropzone";
import { formatRemainingLong } from "@/lib/format";
import { GUEST_UPLOAD_TTL_HOURS } from "@/lib/guest-shared";
import { routeParams } from "@/lib/navigation";
import { useUploadQueue } from "@/lib/upload-queue";
import { useNow } from "@/lib/use-now";

/**
 * Guest upload page, /guest/<token>. Whoever holds the link uploads here
 * without an account. On purpose it shows nothing but its own queue: no
 * listing, no storage gauge, nothing that says what else lives on the server.
 */
export function GuestPage() {
  const { token } = routeParams();
  const [link, setLink] = useState<GuestInfo | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [loading, setLoading] = useState(true);
  const [encrypt, setEncrypt] = useState(true);
  const now = useNow();

  const headers = useMemo(() => ({ "x-docdrop-guest": token }), [token]);
  // Mid-upload expiry or revocation: the guest gets told, not bounced to a
  // sign-in they have no account for.
  const onUnauthorized = useCallback(() => setInvalid(true), []);
  const { items, enqueue, cancel, retry, remove, clearFinished } = useUploadQueue({
    ttlHours: GUEST_UPLOAD_TTL_HOURS,
    maxDownloads: 0,
    encrypt,
    headers,
    onUnauthorized,
  });

  useEffect(() => {
    let cancelled = false;
    fetchGuestInfo(token).then((info) => {
      if (cancelled) return;
      if (info) setLink(info);
      else setInvalid(true);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // The link may expire while the tab sits open.
  const usable = !loading && !invalid && link !== null && link.expiresAt > now;
  const dragging = useWindowDrop(enqueue, usable);
  usePasteFiles(enqueue, usable);

  return (
    <>
      <Header />
      <DropOverlay show={dragging} />

      <main className="container-md guest pb-safe">
        {loading ? (
          <Skeleton style={{ height: 300, borderRadius: 28 }} />
        ) : !usable ? (
          <div className="card state rise">
            <FileIcon kind="file" size="lg" />
            <h1>This guest link is no longer valid</h1>
            <p>It expired or was revoked. Ask whoever sent it to you for a new one.</p>
            <span className="badge" data-tone="danger">
              <Link2Off aria-hidden />
              Link closed
            </span>
          </div>
        ) : (
          <>
            <div className="guest-head rise">
              <h1>{link?.label ? `Hi ${link.label}, drop your files here` : "Drop your files here"}</h1>
              <p>
                They go straight to whoever sent you this link.
                {link && <> The link works for another {formatRemainingLong(link.expiresAt, now)}.</>}
              </p>
            </div>

            <section aria-label="Upload files">
              <Dropzone onFiles={enqueue} dragging={dragging} folders={false} compact />

              <div className="card guest-opts">
                <EncryptionChoice value={encrypt} onChange={setEncrypt} />
              </div>

              <p className="guest-live">
                <ShieldCheck size={15} aria-hidden style={{ color: "var(--ok-text)" }} />
                {items.some((i) => i.state === "uploading")
                  ? "Uploading — keep this tab open until it finishes."
                  : "Nothing on this server is visible from here: only what you send."}
              </p>

              <div className="dash-queue">
                <UploadQueue
                  items={items}
                  onCancel={cancel}
                  onRetry={retry}
                  onRemove={remove}
                  onClearFinished={clearFinished}
                  guestMode
                />
              </div>
            </section>
          </>
        )}
      </main>
    </>
  );
}
