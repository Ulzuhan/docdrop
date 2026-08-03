"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { CopyLinkButton } from "@/components/copy-link-button";
import { ShareButton } from "@/components/share-button";
import { fileEmoji, formatBytes } from "@/lib/format";
import { uploadFileInChunks, type UploadHandle, type UploadResult } from "@/lib/chunked-upload";

type ItemState = "pending" | "uploading" | "done" | "error" | "cancelled";

export interface QueueItem {
  key: string;
  file: File;
  state: ItemState;
  loaded: number;
  resumed: boolean;
  error?: string;
  result?: UploadResult;
}

interface Props {
  ttlHours: number;
  onCompleted: () => void;
}

export interface UploadQueueHandle {
  enqueue: (files: File[]) => void;
  hasItems: boolean;
}

/**
 * Cola de subidas.
 *
 * Los ficheros se suben de dos en dos: lanzarlos todos a la vez reparte el ancho de
 * banda entre muchas conexiones y hace que ninguno termine, que con vídeos de varios
 * GB es lo peor posible. De dos en dos se aprovecha el enlace y se ve avanzar algo.
 */
export function useUploadQueue({ ttlHours, onCompleted }: Props) {
  const [items, setItems] = useState<QueueItem[]>([]);
  // La cola vive en una ref y el estado es solo su reflejo para pintar: la lógica
  // necesita leer la lista actual fuera del ciclo de render, y así no se muta nunca
  // un objeto ya entregado a React.
  const queue = useRef<QueueItem[]>([]);
  const handles = useRef(new Map<string, UploadHandle>());
  const running = useRef(0);
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const ttlRef = useRef(ttlHours);

  useEffect(() => {
    ttlRef.current = ttlHours;
  }, [ttlHours]);

  const commit = useCallback((next: QueueItem[]) => {
    queue.current = next;
    setItems(next);
  }, []);

  const update = useCallback(
    (key: string, patch: Partial<QueueItem>) => {
      commit(queue.current.map((it) => (it.key === key ? { ...it, ...patch } : it)));
    },
    [commit]
  );

  /**
   * Mantiene la pantalla encendida mientras se sube. En el móvil, bloquear la
   * pantalla suspende la subida: la reanudación evita perder el progreso, pero
   * obliga a volver y reelegir el fichero. Esto lo evita de entrada.
   */
  const acquireWakeLock = useCallback(async () => {
    if (wakeLock.current || !("wakeLock" in navigator)) return;
    try {
      wakeLock.current = await navigator.wakeLock.request("screen");
      wakeLock.current.addEventListener("release", () => {
        wakeLock.current = null;
      });
    } catch {
      // El navegador puede denegarlo (pestaña en segundo plano, batería baja).
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    wakeLock.current?.release().catch(() => {});
    wakeLock.current = null;
  }, []);

  // El sistema retira el bloqueo al ocultar la pestaña; se recupera al volver.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible" && running.current > 0) {
        void acquireWakeLock();
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [acquireWakeLock]);

  // pump se reprograma a sí misma al terminar cada subida; la referencia indirecta
  // evita usar la constante antes de declararla.
  const pumpRef = useRef<() => void>(() => {});

  const pump = useCallback(() => {
    const MAX_PARALLEL = 2;

    for (const item of queue.current) {
      if (running.current >= MAX_PARALLEL) break;
      if (item.state !== "pending") continue;

      const { key, file } = item;
      running.current += 1;
      update(key, { state: "uploading" });
      void acquireWakeLock();

      const handle = uploadFileInChunks(file, {
        ttlHours: ttlRef.current,
        onProgress: ({ loaded, resumed }) => update(key, { loaded, resumed }),
      });
      handles.current.set(key, handle);

      handle.promise
        .then((result) => {
          update(key, { state: "done", result, loaded: file.size });
          toast.success("Subido", { description: file.name });
          onCompleted();
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : "La subida falló";
          if (message === "UNAUTHORIZED") {
            window.location.href = "/login";
            return;
          }
          if (message === "ABORTED") {
            update(key, { state: "cancelled" });
          } else {
            update(key, { state: "error", error: message });
            toast.error(file.name, { description: message });
          }
        })
        .finally(() => {
          handles.current.delete(key);
          running.current -= 1;
          if (running.current === 0) releaseWakeLock();
          // Arranca el siguiente de la cola.
          setTimeout(() => pumpRef.current(), 0);
        });
    }
  }, [acquireWakeLock, releaseWakeLock, onCompleted, update]);

  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  const enqueue = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const base = queue.current.length;
      commit([
        ...queue.current,
        ...files.map((file, i) => ({
          // Clave estable aunque se repita nombre y tamaño en el mismo lote.
          key: `${file.name}:${file.size}:${file.lastModified}:${base + i}`,
          file,
          state: "pending" as ItemState,
          loaded: 0,
          resumed: false,
        })),
      ]);
      setTimeout(() => pumpRef.current(), 0);
    },
    [commit]
  );

  const cancel = useCallback((key: string) => {
    handles.current.get(key)?.abort();
  }, []);

  const clearFinished = useCallback(() => {
    commit(queue.current.filter((it) => it.state === "pending" || it.state === "uploading"));
  }, [commit]);

  return { items, enqueue, cancel, clearFinished };
}

// ─── Presentación ────────────────────────────────────────────────────
export function UploadQueue({
  items,
  onCancel,
  onClearFinished,
}: {
  items: QueueItem[];
  onCancel: (key: string) => void;
  onClearFinished: () => void;
}) {
  if (items.length === 0) return null;

  const active = items.filter((i) => i.state === "uploading" || i.state === "pending");
  const totalBytes = items.reduce((sum, i) => sum + i.file.size, 0);
  const loadedBytes = items.reduce(
    (sum, i) => sum + (i.state === "done" ? i.file.size : i.loaded),
    0
  );
  const globalPct = totalBytes > 0 ? Math.round((loadedBytes / totalBytes) * 100) : 0;

  return (
    <section aria-label="Cola de subida" className="mt-6 space-y-3">
      {items.length > 1 && (
        <div className="rounded-xl border border-border bg-card/60 p-3">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium">
              {active.length > 0
                ? `Subiendo ${items.length - active.length + 1} de ${items.length}`
                : `${items.length} ficheros`}
            </span>
            <span className="tabular-nums text-muted-foreground">
              {formatBytes(loadedBytes)} / {formatBytes(totalBytes)}
            </span>
          </div>
          <Progress value={globalPct} className="h-2" />
        </div>
      )}

      <ul className="space-y-2">
        {items.map((item) => {
          const pct =
            item.state === "done"
              ? 100
              : item.file.size > 0
                ? Math.round((item.loaded / item.file.size) * 100)
                : 0;

          return (
            <li
              key={item.key}
              className="overflow-hidden rounded-xl border border-border/70 bg-card/60 p-3"
            >
              <div className="flex items-center gap-3">
                <span aria-hidden className="text-lg">
                  {item.state === "done" ? "✅" : fileEmoji(item.file.type, item.file.name)}
                </span>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={item.file.name}>
                    {item.file.name}
                  </p>
                  <p className="text-xs tabular-nums text-muted-foreground">
                    {item.state === "pending" && "en espera"}
                    {item.state === "uploading" &&
                      `${formatBytes(item.loaded)} / ${formatBytes(item.file.size)} · ${pct}%`}
                    {item.state === "done" && formatBytes(item.file.size)}
                    {item.state === "error" && (
                      <span className="text-destructive">{item.error}</span>
                    )}
                    {item.state === "cancelled" && "cancelada"}
                    {item.resumed && item.state === "uploading" && (
                      <span className="text-success"> · continuando</span>
                    )}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  {item.state === "done" && item.result && (
                    <>
                      <ShareButton
                        path={item.result.downloadUrl}
                        title={item.result.originalName}
                      />
                      <CopyLinkButton
                        path={item.result.downloadUrl}
                        variant="ghost"
                        className="size-9"
                      />
                    </>
                  )}
                  {(item.state === "uploading" || item.state === "pending") && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-9"
                      aria-label={`Cancelar ${item.file.name}`}
                      onClick={() => onCancel(item.key)}
                    >
                      {item.state === "uploading" ? (
                        <X className="size-4" aria-hidden />
                      ) : (
                        <Loader2 className="size-4 animate-spin opacity-40" aria-hidden />
                      )}
                    </Button>
                  )}
                  {item.state === "done" && (
                    <CheckCircle2 className="size-4 text-success" aria-hidden />
                  )}
                </div>
              </div>

              {(item.state === "uploading" || item.state === "pending") && (
                <Progress value={pct} className="mt-2 h-1" />
              )}
            </li>
          );
        })}
      </ul>

      {items.some((i) => i.state !== "uploading" && i.state !== "pending") && (
        <button
          onClick={onClearFinished}
          className="w-full text-center text-xs text-muted-foreground hover:text-foreground"
        >
          Limpiar terminados
        </button>
      )}
    </section>
  );
}
