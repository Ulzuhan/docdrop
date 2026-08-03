"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileUp, Flame, FolderUp, LogOut } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SiteHeader } from "@/components/site-header";
import { FileRow, type FileInfo } from "@/components/file-row";
import { UploadQueue, useUploadQueue } from "@/components/upload-queue";

const TTL_OPTIONS = [
  { hours: 1, label: "1 h" },
  { hours: 6, label: "6 h" },
  { hours: 24, label: "1 día" },
  { hours: 72, label: "3 días" },
];

export default function Home() {
  const [isDragging, setIsDragging] = useState(false);
  const [ttl, setTtl] = useState(24);
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
    onCompleted: refresh,
  });

  // Reloj compartido por las cuentas atrás, en estado y no leído durante el render.
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
          window.location.href = "/login";
          return;
        }
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        setFiles(data.files);
        setStorage(data.storage ?? null);
        setAuthEnabled(Boolean(data.authEnabled));
      } catch {
        // Un fallo puntual de red no debe vaciar la lista ya pintada.
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

  // Fichero llegado desde el menú "Compartir" del móvil: el service worker lo deja
  // guardado y redirige aquí con ?shared=1.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shared = params.get("shared");
    if (!shared) return;
    window.history.replaceState({}, "", "/");

    if (shared === "error") {
      toast.error("No se pudo recibir el fichero compartido");
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
        toast.error("No se pudo leer el fichero compartido");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enqueue]);

  /** Extrae los ficheros de un arrastre, entrando en las carpetas si las hay. */
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
        // readEntries devuelve como mucho 100 por llamada: hay que insistir.
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
          authEnabled ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Cerrar sesión"
              className="size-10 rounded-full text-muted-foreground hover:text-foreground"
              onClick={async () => {
                await fetch("/api/auth/logout", { method: "POST" });
                window.location.href = "/login";
              }}
            >
              <LogOut className="size-[18px]" />
            </Button>
          ) : null
        }
      />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pt-8 pb-safe sm:px-6 sm:pt-12">
        <div className="mb-8 text-center sm:mb-10">
          <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Comparte ficheros en segundos
          </h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground text-balance sm:text-base">
            Súbelos, comparte el enlace y deja que se borren solos.
          </p>
        </div>

        {/* ── Zona de subida ─────────────────────────────────────────── */}
        <section aria-label="Subir ficheros">
          <div
            onDragEnter={(e) => {
              e.preventDefault();
              dragDepth.current += 1;
              setIsDragging(true);
            }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={(e) => {
              e.preventDefault();
              // Contador de profundidad: sin esto, arrastrar sobre un hijo dispara
              // dragleave y el resaltado parpadea.
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
            <input
              ref={folderInputRef}
              type="file"
              multiple
              // @ts-expect-error atributo no estándar, soportado por los navegadores
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
                Toca para elegir ficheros
              </span>
              <span className="text-sm text-muted-foreground">
                <span className="hidden sm:inline">o arrástralos aquí · </span>
                varios a la vez · hasta 10 GB cada uno
              </span>
            </button>
          </div>

          <div className="mt-4 flex flex-col items-center gap-3 sm:flex-row sm:justify-between">
            <Button
              variant="ghost"
              size="sm"
              className="h-9 text-muted-foreground hover:text-foreground"
              onClick={() => folderInputRef.current?.click()}
            >
              <FolderUp className="size-4" aria-hidden />
              Subir una carpeta
            </Button>

            <div className="flex flex-col items-center gap-2 sm:flex-row sm:gap-3">
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Flame className="size-3.5" aria-hidden />
                Se autodestruye en
              </span>
              <div
                role="radiogroup"
                aria-label="Tiempo hasta la autodestrucción"
                className="grid w-full grid-cols-4 gap-1.5 rounded-xl bg-muted/60 p-1 sm:w-auto"
              >
                {TTL_OPTIONS.map((option) => (
                  <button
                    key={option.hours}
                    role="radio"
                    aria-checked={ttl === option.hours}
                    onClick={() => setTtl(option.hours)}
                    className={`rounded-lg px-3 py-2 text-sm font-medium transition-all sm:py-1.5 ${
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

          <UploadQueue items={items} onCancel={cancel} onClearFinished={clearFinished} />
        </section>

        {/* ── Lista ──────────────────────────────────────────────────── */}
        <section aria-label="Ficheros activos" className="mt-10 sm:mt-12">
          <h2 className="mb-3 px-1 text-sm font-medium text-muted-foreground">
            Ficheros activos {files.length > 0 && `(${files.length})`}
          </h2>

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
                Todavía no hay nada. Los ficheros que subas aparecerán aquí.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {files.map((file) => (
                <FileRow
                  key={file.id}
                  file={file}
                  now={now}
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
