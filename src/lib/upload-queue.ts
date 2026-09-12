/**
 * The upload queue.
 *
 * Files go up two at a time: firing them all at once splits the bandwidth
 * across many connections and nothing finishes, which with multi-GB videos is
 * the worst possible outcome. Two keeps the link busy and something visibly
 * moving.
 *
 * Encryption is on by default and decided per upload. When it is on, the key
 * is born here, written to the local keyring before the first byte leaves
 * (a resume with a lost key would produce a Frankenstein bundle), and moved to
 * hang off the file id once the upload completes. The transport underneath
 * (`chunked-upload.ts`) never learns that encryption exists.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import { uploadFileInChunks, type UploadHandle, type UploadResult } from "@/lib/chunked-upload";
import {
  NOMBRE_CIFRADO,
  TIPO_CIFRADO,
  apuntarClaveEnVuelo,
  claveEnVuelo,
  consolidarClave,
  fuenteCifrada,
} from "@/lib/e2ee-client";

export type ItemState = "pending" | "uploading" | "done" | "error" | "cancelled";

export interface QueueItem {
  key: string;
  file: File;
  state: ItemState;
  /** Bytes the server has confirmed. */
  loaded: number;
  /** Bytes on the wire for this upload (the encrypted bundle is a little larger). */
  total: number;
  resumed: boolean;
  /** When this attempt started moving bytes, and how many it already had then. */
  startedAt?: number;
  baseline?: number;
  error?: string;
  result?: UploadResult & { encrypted: boolean };
}

export interface QueueOptions {
  ttlHours: number;
  maxDownloads: number;
  /** Encrypt in the browser before the first byte leaves it. */
  encrypt: boolean;
  onCompleted?: () => void;
  /** Extra headers on every upload request: how the guest page authenticates. */
  headers?: Record<string, string>;
  /** Called on 401. The dashboard signs in again; the guest page shows its own message. */
  onUnauthorized?: () => void;
}

const MAX_PARALLEL = 2;

export function useUploadQueue({
  ttlHours,
  maxDownloads,
  encrypt,
  onCompleted,
  headers,
  onUnauthorized,
}: QueueOptions) {
  const [items, setItems] = useState<QueueItem[]>([]);
  // The queue lives in a ref and state mirrors it for painting: the logic reads
  // the current list outside the render cycle, and never mutates an object
  // already handed to React.
  const queue = useRef<QueueItem[]>([]);
  const handles = useRef(new Map<string, UploadHandle>());
  const running = useRef(0);
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  // Options are read when each upload starts, not when it is queued: changing
  // them affects whatever is still pending without rebuilding the queue.
  const options = useRef({ ttlHours, maxDownloads, encrypt, headers, onCompleted, onUnauthorized });
  useEffect(() => {
    options.current = { ttlHours, maxDownloads, encrypt, headers, onCompleted, onUnauthorized };
  }, [ttlHours, maxDownloads, encrypt, headers, onCompleted, onUnauthorized]);

  const commit = useCallback((next: QueueItem[]) => {
    queue.current = next;
    setItems(next);
  }, []);

  const update = useCallback(
    (key: string, patch: Partial<QueueItem>) => {
      commit(queue.current.map((item) => (item.key === key ? { ...item, ...patch } : item)));
    },
    [commit]
  );

  /**
   * Keeps the screen awake while uploading. On a phone, locking the screen
   * suspends the upload: resuming saves the progress but forces the person to
   * come back and pick the file again. This avoids that in the first place.
   */
  const acquireWakeLock = useCallback(async () => {
    if (wakeLock.current || !("wakeLock" in navigator)) return;
    try {
      wakeLock.current = await navigator.wakeLock.request("screen");
      wakeLock.current.addEventListener("release", () => {
        wakeLock.current = null;
      });
    } catch {
      // The browser may refuse (background tab, low battery).
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    wakeLock.current?.release().catch(() => {});
    wakeLock.current = null;
  }, []);

  // The system drops the lock when the tab is hidden; take it again on return.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible" && running.current > 0) void acquireWakeLock();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [acquireWakeLock]);

  const pumpRef = useRef<() => void>(() => {});

  const pump = useCallback(() => {
    for (const item of queue.current) {
      if (running.current >= MAX_PARALLEL) break;
      if (item.state !== "pending") continue;

      const { key, file } = item;
      const opts = options.current;
      running.current += 1;
      update(key, { state: "uploading" });
      void acquireWakeLock();

      const onProgress = ({ loaded, total, resumed }: { loaded: number; total: number; resumed: boolean }) => {
        const current = queue.current.find((it) => it.key === key);
        const patch: Partial<QueueItem> = { loaded, total, resumed };
        if (current && current.startedAt === undefined) {
          patch.startedAt = Date.now();
          patch.baseline = loaded;
        }
        update(key, patch);
      };

      // `fuenteCifrada` is asynchronous (it encrypts the header), so the handle
      // is assembled in two steps: the outer promise chains source → transport,
      // and `abort` is re-pointed at the real transport as soon as it exists.
      const control: { abort: () => void } = { abort: () => {} };
      const promise: Promise<UploadResult & { encrypted: boolean }> = (async () => {
        if (!opts.encrypt) {
          const inner = uploadFileInChunks(file, {
            ttlHours: opts.ttlHours,
            maxDownloads: opts.maxDownloads,
            onProgress,
            headers: opts.headers,
          });
          control.abort = inner.abort;
          const result = await inner.promise;
          return { ...result, encrypted: false };
        }
        const previousKey = claveEnVuelo(file) ?? undefined;
        const source = await fuenteCifrada(file, previousKey);
        apuntarClaveEnVuelo(file, source.fragmento);
        const inner = uploadFileInChunks(file, {
          ttlHours: opts.ttlHours,
          maxDownloads: opts.maxDownloads,
          onProgress,
          headers: opts.headers,
          fuente: source,
          neutro: { filename: NOMBRE_CIFRADO, mimeType: TIPO_CIFRADO },
        });
        control.abort = inner.abort;
        const result = await inner.promise;
        consolidarClave(file, result.id, source.fragmento);
        // The useful link carries the key; the real name is the file's own.
        return {
          ...result,
          originalName: file.name,
          downloadUrl: `${result.downloadUrl}#${source.fragmento}`,
          encrypted: true,
        };
      })();
      handles.current.set(key, { promise, abort: () => control.abort() });

      promise
        .then((result) => {
          const current = queue.current.find((it) => it.key === key);
          update(key, { state: "done", result, loaded: current?.total ?? result.size });
          toast.success("Uploaded", file.name);
          options.current.onCompleted?.();
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "Upload failed";
          if (message === "UNAUTHORIZED") {
            if (options.current.onUnauthorized) {
              update(key, { state: "error", error: "This link no longer allows uploads" });
              options.current.onUnauthorized();
            } else {
              window.location.href = "/api/auth/login";
            }
            return;
          }
          if (message === "ABORTED") {
            update(key, { state: "cancelled" });
          } else {
            update(key, { state: "error", error: message });
            toast.error(file.name, message);
          }
        })
        .finally(() => {
          handles.current.delete(key);
          running.current -= 1;
          if (running.current === 0) releaseWakeLock();
          setTimeout(() => pumpRef.current(), 0);
        });
    }
  }, [acquireWakeLock, releaseWakeLock, update]);

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
          // Stable even when name and size repeat within the same batch.
          key: `${file.name}:${file.size}:${file.lastModified}:${base + i}:${Date.now()}`,
          file,
          state: "pending" as ItemState,
          loaded: 0,
          total: file.size,
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

  /** Puts a failed or cancelled item back at the end of the queue. */
  const retry = useCallback(
    (key: string) => {
      const item = queue.current.find((it) => it.key === key);
      if (!item || (item.state !== "error" && item.state !== "cancelled")) return;
      commit(queue.current.filter((it) => it.key !== key));
      enqueue([item.file]);
    },
    [commit, enqueue]
  );

  const remove = useCallback(
    (key: string) => {
      commit(queue.current.filter((it) => it.key !== key || it.state === "uploading"));
    },
    [commit]
  );

  const clearFinished = useCallback(() => {
    commit(queue.current.filter((it) => it.state === "pending" || it.state === "uploading"));
  }, [commit]);

  return { items, enqueue, cancel, retry, remove, clearFinished };
}
