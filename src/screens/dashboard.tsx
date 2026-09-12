import { useCallback, useEffect, useState } from "react";
import { Header } from "@/components/header";
import { AccountMenu } from "@/components/account-menu";
import { Dropzone, DropOverlay } from "@/components/dropzone";
import { FileList } from "@/components/file-list";
import { GuestLinksButton } from "@/components/guest-links";
import { UploadOptions } from "@/components/upload-options";
import { UploadQueue } from "@/components/upload-queue";
import { SIGN_IN_URL, fetchFiles, type FileInfo, type StorageInfo } from "@/lib/api";
import { usePasteFiles, useWindowDrop } from "@/lib/dropzone";
import { toast } from "@/lib/toast";
import { useUploadQueue } from "@/lib/upload-queue";
import { useNow } from "@/lib/use-now";

/**
 * The dashboard: drop files, set how long they live, share the links, watch
 * them burn down. The server decided there is a session before rendering this.
 */
export function Dashboard({ email, accountUrl }: { email: string; accountUrl: string | null }) {
  const [ttl, setTtl] = useState(24);
  const [maxDownloads, setMaxDownloads] = useState(0);
  // Encrypted by default. Turning it off is a per-upload decision, asked every
  // time: the safe setting should not depend on what somebody chose another day.
  const [encrypt, setEncrypt] = useState(true);

  const [files, setFiles] = useState<FileInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reload, setReload] = useState(0);
  const now = useNow();

  const refresh = useCallback(() => setReload((n) => n + 1), []);
  const { items, enqueue, cancel, retry, remove, clearFinished } = useUploadQueue({
    ttlHours: ttl,
    maxDownloads,
    encrypt,
    onCompleted: refresh,
  });

  const dragging = useWindowDrop(enqueue);
  usePasteFiles(enqueue);

  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  // The list, refreshed every ten seconds and after each upload. A one-off
  // network blip must not wipe what is on screen.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const result = await fetchFiles();
      if (cancelled) return;
      if (!result.ok) {
        if (result.unauthorized) window.location.href = SIGN_IN_URL;
        setLoading(false);
        return;
      }
      setFiles(result.files);
      setStorage(result.storage);
      setSelected((prev) => {
        const alive = new Set(result.files.map((f) => f.id));
        const next = new Set([...prev].filter((id) => alive.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setLoading(false);
    }
    void load();
    const interval = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [reload]);

  // A file arriving from the phone's "Share" menu: the service worker stored it
  // and redirected here with ?shared=1.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shared = params.get("shared");
    if (!shared) return;
    window.history.replaceState({}, "", "/");
    if (shared === "error") {
      toast.error("Could not receive the shared file");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/__shared-file__");
        if (!res.ok) return;
        const name = decodeURIComponent(res.headers.get("X-Shared-Filename") || "shared");
        const blob = await res.blob();
        if (!cancelled) enqueue([new File([blob], name, { type: blob.type })]);
      } catch {
        toast.error("Could not read the shared file");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enqueue]);

  return (
    <>
      <Header storage={storage}>
        <AccountMenu email={email} accountUrl={accountUrl} />
      </Header>
      <DropOverlay show={dragging} />

      <main className="container dash pb-safe">
        <div className="dash-head rise">
          <div>
            <h1>Share a file</h1>
            <p>Drop it, send the link, and let it burn out on its own.</p>
          </div>
          <div className="tools">
            <GuestLinksButton />
          </div>
        </div>

        <section aria-label="Upload files">
          <div className="dash-grid">
            <Dropzone onFiles={enqueue} dragging={dragging} />
            <UploadOptions
              ttl={ttl}
              setTtl={setTtl}
              maxDownloads={maxDownloads}
              setMaxDownloads={setMaxDownloads}
              encrypt={encrypt}
              setEncrypt={setEncrypt}
            />
          </div>
          <div className="dash-queue">
            <UploadQueue
              items={items}
              onCancel={cancel}
              onRetry={retry}
              onRemove={remove}
              onClearFinished={clearFinished}
            />
          </div>
        </section>

        <FileList
          files={files}
          loading={loading}
          now={now}
          selected={selected}
          onToggle={toggleSelected}
          onClearSelection={clearSelection}
          onDeleted={(id) => {
            setFiles((prev) => prev.filter((f) => f.id !== id));
            refresh();
          }}
        />
      </main>
    </>
  );
}
