"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, FileUp, Flame, Loader2, LogOut, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { SiteHeader } from "@/components/site-header";
import { CopyLinkButton } from "@/components/copy-link-button";
import { FileRow, type FileInfo } from "@/components/file-row";
import { formatBytes, formatRemaining } from "@/lib/format";
import {
  uploadFileInChunks,
  type UploadHandle,
  type UploadResult,
} from "@/lib/chunked-upload";

const TTL_OPTIONS = [
  { hours: 1, label: "1 h" },
  { hours: 6, label: "6 h" },
  { hours: 24, label: "1 día" },
  { hours: 72, label: "3 días" },
];

export default function Home() {
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [resumedNotice, setResumedNotice] = useState(false);
  const [uploadingName, setUploadingName] = useState("");
  const [result, setResult] = useState<UploadResult | null>(null);
  const [ttl, setTtl] = useState(24);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [storage, setStorage] = useState<{ usedBytes: number; totalBytes: number } | null>(null);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<UploadHandle | null>(null);
  const dragDepth = useRef(0);

  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

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

  const uploadFile = useCallback(
    async (file: File) => {
      setUploading(true);
      setProgress(0);
      setUploadedBytes(0);
      setTotalBytes(file.size);
      setUploadingName(file.name);
      setResult(null);

      // La subida se parte en trozos: sortea el tope de 500 MiB por petición que
      // impone Cloudflare y, sobre todo, permite retomarla si la red se corta.
      const handle = uploadFileInChunks(file, {
        ttlHours: ttl,
        onProgress: ({ loaded, total, resumed }) => {
          setUploadedBytes(loaded);
          setProgress(total > 0 ? Math.round((loaded / total) * 100) : 0);
          if (resumed) setResumedNotice(true);
        },
      });
      uploadRef.current = handle;

      try {
        const response = await handle.promise;
        setResult(response);
        toast.success("Fichero subido", { description: response.originalName });
        refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "La subida falló";
        if (message === "UNAUTHORIZED") {
          window.location.href = "/login";
          return;
        }
        if (message !== "ABORTED") {
          toast.error(message, {
            description: "Vuelve a elegir el mismo fichero para continuar donde iba.",
          });
        }
      } finally {
        uploadRef.current = null;
        setUploading(false);
        setResumedNotice(false);
      }
    },
    [ttl, refresh]
  );

  // Referencia estable para poder lanzar la subida desde el efecto de "compartir"
  // sin encadenarlo a las dependencias de uploadFile.
  const uploadFileRef = useRef(uploadFile);
  useEffect(() => {
    uploadFileRef.current = uploadFile;
  }, [uploadFile]);

  // Fichero llegado desde el menú "Compartir" del móvil: el service worker lo deja
  // guardado y redirige aquí con ?shared=1.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shared = params.get("shared");
    if (!shared) return;

    // Se limpia la URL para que al recargar no se reintente la misma subida.
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
        if (cancelled) return;
        void uploadFileRef.current?.(new File([blob], name, { type: blob.type }));
      } catch {
        toast.error("No se pudo leer el fichero compartido");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  function handleFiles(list: FileList | null) {
    const file = list?.[0];
    if (file) void uploadFile(file);
    if (list && list.length > 1) {
      toast.info("Se sube un fichero cada vez", {
        description: `Enviando “${list[0].name}”.`,
      });
    }
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
            Comparte un fichero en segundos
          </h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground text-balance sm:text-base">
            Súbelo, comparte el enlace y deja que se borre solo.
          </p>
        </div>

        {/* ── Zona de subida ─────────────────────────────────────────── */}
        {!result && (
          <section aria-label="Subir fichero">
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
                if (!uploading) handleFiles(e.dataTransfer.files);
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
                className="sr-only"
                onChange={(e) => {
                  handleFiles(e.target.files);
                  e.target.value = "";
                }}
              />

              {uploading ? (
                <div className="space-y-4 p-6 sm:p-10">
                  <div className="flex items-center gap-3">
                    <Loader2 className="size-5 shrink-0 animate-spin text-primary" aria-hidden />
                    <p className="min-w-0 flex-1 truncate text-sm font-medium">{uploadingName}</p>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0"
                      aria-label="Cancelar subida"
                      onClick={() => uploadRef.current?.abort()}
                    >
                      <X className="size-4" aria-hidden />
                    </Button>
                  </div>
                  <Progress value={progress} className="h-2" />
                  <div className="flex items-center justify-between text-sm tabular-nums text-muted-foreground">
                    <span>
                      {formatBytes(uploadedBytes)} / {formatBytes(totalBytes)}
                    </span>
                    <span>{progress}%</span>
                  </div>
                  {resumedNotice && (
                    <p className="text-center text-xs text-success">
                      Continuando una subida anterior
                    </p>
                  )}
                  <p className="text-center text-xs text-muted-foreground">
                    Se envía por partes: si se corta, vuelve a elegir el mismo fichero y
                    sigue donde iba.
                  </p>
                </div>
              ) : (
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
                    Toca para elegir un fichero
                  </span>
                  <span className="text-sm text-muted-foreground">
                    <span className="hidden sm:inline">o arrástralo aquí · </span>
                    hasta 10 GB
                  </span>
                </button>
              )}
            </div>

            {/* Caducidad */}
            <div className="mt-5 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
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
                    disabled={uploading}
                    className={`rounded-lg px-3 py-2 text-sm font-medium transition-all disabled:opacity-50 sm:py-1.5 ${
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
          </section>
        )}

        {/* ── Resultado ──────────────────────────────────────────────── */}
        {result && (
          <section
            aria-label="Fichero subido"
            className="rounded-2xl border border-success/30 bg-success/5 p-5 sm:p-6"
          >
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium" title={result.originalName}>
                  {result.originalName}
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {formatBytes(result.size)} · caduca en {formatRemaining(result.expiresAt, now)}
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-border bg-background/70 px-3 py-2.5">
              <p className="truncate font-mono text-xs text-muted-foreground sm:text-sm">
                {typeof window !== "undefined" ? window.location.origin : ""}
                {result.downloadUrl}
              </p>
            </div>

            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <CopyLinkButton
                path={result.downloadUrl}
                label="Copiar enlace"
                variant="default"
                className="w-full sm:flex-1"
              />
              <Button variant="outline" className="w-full sm:w-auto" onClick={() => setResult(null)}>
                <Upload className="size-4" aria-hidden />
                Subir otro
              </Button>
            </div>
          </section>
        )}

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
