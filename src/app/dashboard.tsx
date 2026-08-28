"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileUp, Flame, FolderUp, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SiteHeader } from "@/components/site-header";
import { KaiCorpAccountMenu } from "@/components/kaicorp-account-menu";
import { FileRow, type FileInfo } from "@/components/file-row";
import { UploadQueue, useUploadQueue } from "@/components/upload-queue";
import { UploaderNameField } from "@/components/uploader-name-field";
import { GuestLinksDialog } from "@/components/guest-links-dialog";

const TTL_OPTIONS = [
  { hours: 1, label: "1 h" },
  { hours: 6, label: "6 h" },
  { hours: 24, label: "1 day" },
  { hours: 72, label: "3 days" },
];

/** 0 = no limit. With a limit, the file is deleted once it runs out. */
const DOWNLOAD_OPTIONS = [
  { value: 0, label: "∞" },
  { value: 1, label: "1" },
  { value: 5, label: "5" },
  { value: 20, label: "20" },
];

/**
 * The dashboard proper. Client component; the server gate lives in page.tsx,
 * which shows the landing page instead when there is no session — it does not
 * redirect anywhere, and `/login` does not exist in this app.
 */
/**
 * `email` y `accountUrl` llegan del servidor porque el menú de cuenta es cromado común:
 * aquí, de las cinco aplicaciones, era donde peor estaba —un icono de salir suelto en la
 * cabecera, sin decir siquiera de quién era la sesión—.
 */
export function Dashboard({ email, accountUrl }: { email: string; accountUrl: string | null }) {
  const [isDragging, setIsDragging] = useState(false);
  const [ttl, setTtl] = useState(24);
  const [maxDownloads, setMaxDownloads] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [storage, setStorage] = useState<{ usedBytes: number; totalBytes: number } | null>(null);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);
  const { items, enqueue, cancel, clearFinished } = useUploadQueue({
    ttlHours: ttl,
    maxDownloads,
    onCompleted: refresh,
  });

  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /**
   * Downloads the selected files as one archive. It navigates instead of using
   * fetch, so the browser writes straight to disk rather than buffering in memory,
   * which would be unworkable with several GB.
   */
  const downloadZip = useCallback(() => {
    const ids = [...selected].join(",");
    if (!ids) return;
    window.location.href = `/api/zip?ids=${ids}`;
    setSelected(new Set());
  }, [selected]);

  // Clock shared by the countdowns, kept in state and never read during render.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/files");
        if (res.status === 401) {
          // `/login` no existe en esta aplicación —solo hay `/`— así que esto
          // llevaba a un 404 cuando caducaba la sesión. El punto de entrada real
          // es la ruta de API, que redirige al proveedor de identidad.
          window.location.href = "/api/auth/login";
          return;
        }
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        setFiles(data.files);
        setSelected((prev) => {
          const alive = new Set(data.files.map((f: FileInfo) => f.id));
          const next = new Set([...prev].filter((id) => alive.has(id)));
          return next.size === prev.size ? prev : next;
        });
        setStorage(data.storage ?? null);
        setAuthEnabled(Boolean(data.authEnabled));
      } catch {
        // A one-off network blip must not wipe the list already on screen.
      } finally {
        if (!cancelled) setLoadingFiles(false);
      }
    }

    void load();
    const interval = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [reloadToken]);

  // File arriving from the phone's "Share" menu: the service worker stores it and
  // redirects here with ?shared=1.
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
        const name = decodeURIComponent(res.headers.get("X-Shared-Filename") || "compartido");
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

  /** Pulls the files out of a drop, walking into folders when there are any. */
  async function filesFromDrop(dataTransfer: DataTransfer): Promise<File[]> {
    const entries = Array.from(dataTransfer.items)
      .map((item) => (item.kind === "file" ? item.webkitGetAsEntry?.() : null))
      .filter(Boolean) as FileSystemEntry[];

    if (entries.length === 0) return Array.from(dataTransfer.files);

    const out: File[] = [];
    async function walk(entry: FileSystemEntry): Promise<void> {
      if (entry.isFile) {
        const file = await new Promise<File | null>((resolve) =>
          (entry as FileSystemFileEntry).file(resolve, () => resolve(null))
        );
        if (file) out.push(file);
        return;
      }
      if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        // readEntries returns at most 100 per call: keep asking.
        for (;;) {
          const batch = await new Promise<FileSystemEntry[]>((resolve) =>
            reader.readEntries(resolve, () => resolve([]))
          );
          if (batch.length === 0) break;
          for (const child of batch) await walk(child);
        }
      }
    }

    for (const entry of entries) await walk(entry);
    return out;
  }

  return (
    <>
      <SiteHeader
        storage={storage}
        actions={
          authEnabled ? <KaiCorpAccountMenu email={email} accountUrl={accountUrl} /> : null
        }
      />

      <main className="kc-workspace dd-workspace mx-auto w-full max-w-6xl flex-1 px-4 pt-8 pb-safe sm:px-6 sm:pt-12">
        <div className="dd-workspace-header mb-8 text-center sm:mb-10">
          <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Share files in seconds
          </h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground text-balance sm:text-base">
            Upload them, share the link, let them delete themselves.
          </p>
        </div>

        {/* ── Upload area ────────────────────────────────────────────── */}
        <section aria-label="Upload files" className="dd-upload-workbench">
          <div
            onDragEnter={(e) => {
              e.preventDefault();
              dragDepth.current += 1;
              setIsDragging(true);
            }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={(e) => {
              e.preventDefault();
              // Depth counter: without it, dragging over a child fires dragleave
              // and the highlight flickers.
              dragDepth.current -= 1;
              if (dragDepth.current <= 0) setIsDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              dragDepth.current = 0;
              setIsDragging(false);
              void filesFromDrop(e.dataTransfer).then((dropped) => {
                if (dropped.length > 0) enqueue(dropped);
              });
            }}
            className={`dd-dropzone relative overflow-hidden rounded-2xl border-2 border-dashed transition-all duration-200 ${
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
            <input
              ref={folderInputRef}
              type="file"
              multiple
              // @ts-expect-error non-standard attribute, supported by browsers
              webkitdirectory=""
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

          <div className="dd-upload-settings mt-5 space-y-4">
            <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
              <Button
                variant="ghost"
                size="sm"
                className="h-9 text-muted-foreground hover:text-foreground"
                onClick={() => folderInputRef.current?.click()}
              >
                <FolderUp className="size-4" aria-hidden />
                Folder
              </Button>
              {/* Without a password everything is open and a guest link grants
                  nothing a stranger does not already have. */}
              {authEnabled && <GuestLinksDialog />}
              <div className="sm:ms-auto">
                <UploaderNameField />
              </div>
            </div>

            {/* Label above control, one group per row. These used to sit inline
                — label, four buttons, label, four buttons — which needs more
                width than the page has: on a phone the last option fell off the
                screen and on a desktop the two groups drew on top of each other.

                They then sat side by side from `sm` up, which was worse in a way
                that hid itself: `sm` asks about the viewport, but what limits
                these controls is the settings card, and from 50rem up the card
                stops being the full page and becomes the 19rem right-hand
                column. So the wider the window, the narrower each option — 74px
                on a phone, 23px on a desktop — and every label under six
                characters broke in half ("3 / days"). One group per row is the
                only arrangement that holds at every width, and it costs nothing:
                the card had vertical room to spare. */}
            <div className="dd-option-groups grid gap-3">
              <div>
                <span
                  id="downloads-label"
                  className="flex items-center gap-1.5 text-sm text-muted-foreground"
                >
                  <Download className="size-3.5" aria-hidden />
                  Downloads
                </span>
                <div
                  role="radiogroup"
                  aria-labelledby="downloads-label"
                  className="mt-1.5 grid grid-cols-4 gap-1.5 rounded-xl bg-muted/60 p-1"
                >
                  {DOWNLOAD_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      role="radio"
                      aria-checked={maxDownloads === option.value}
                      aria-label={
                        option.value === 0 ? "No limit" : `${option.value} downloads`
                      }
                      onClick={() => setMaxDownloads(option.value)}
                      className={`rounded-lg px-2 py-2 text-sm font-medium transition-all ${
                        maxDownloads === option.value
                          ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span
                  id="ttl-label"
                  className="flex items-center gap-1.5 text-sm text-muted-foreground"
                >
                  <Flame className="size-3.5" aria-hidden />
                  Expires in
                </span>
                <div
                  role="radiogroup"
                  aria-labelledby="ttl-label"
                  className="mt-1.5 grid grid-cols-4 gap-1.5 rounded-xl bg-muted/60 p-1"
                >
                  {TTL_OPTIONS.map((option) => (
                    <button
                      key={option.hours}
                      role="radio"
                      aria-checked={ttl === option.hours}
                      onClick={() => setTtl(option.hours)}
                      className={`rounded-lg px-2 py-2 text-sm font-medium transition-all ${
                        ttl === option.hours
                          ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <UploadQueue items={items} onCancel={cancel} onClearFinished={clearFinished} />
        </section>

        {/* ── Listing ────────────────────────────────────────────────── */}
        <section aria-label="Active files" className="dd-files mt-10 sm:mt-12">
          <div className="mb-3 flex min-h-9 items-center justify-between gap-2 px-1">
            <h2 className="text-sm font-medium text-muted-foreground">
              Active files {files.length > 0 && `(${files.length})`}
            </h2>

            {selected.size > 0 && (
              <div className="flex items-center gap-1">
                <Button size="sm" className="h-9" onClick={downloadZip}>
                  <Download className="size-4" aria-hidden />
Download {selected.size} as ZIP
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-9"
aria-label="Clear selection"
                  onClick={() => setSelected(new Set())}
                >
                  <X className="size-4" aria-hidden />
                </Button>
              </div>
            )}
          </div>

          {loadingFiles ? (
            <ul className="space-y-2">
              {[0, 1, 2].map((i) => (
                <li key={i}>
                  <Skeleton className="h-[72px] w-full rounded-xl" />
                </li>
              ))}
            </ul>
          ) : files.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border py-10 text-center">
              <p className="text-sm text-muted-foreground">
Nothing here yet. Files you upload will show up here.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {files.map((file) => (
                <FileRow
                  key={file.id}
                  file={file}
                  now={now}
                  selected={selected.has(file.id)}
                  onToggle={toggleSelected}
                  onDeleted={(id) => {
                    setFiles((prev) => prev.filter((f) => f.id !== id));
                    refresh();
                  }}
                />
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
