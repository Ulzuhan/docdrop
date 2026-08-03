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
import { getUploaderName } from "@/lib/uploader-name";

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
  maxDownloads: number;
  onCompleted: () => void;
}

export interface UploadQueueHandle {
  enqueue: (files: File[]) => void;
  hasItems: boolean;
}

/**
 * Upload queue.
 *
 * Files go up two at a time: firing them all at once splits the bandwidth across
 * many connections and nothing finishes, which with multi-GB videos is the worst
 * possible outcome. Two at a time keeps the link busy and something visibly moving.
 */
export function useUploadQueue({ ttlHours, maxDownloads, onCompleted }: Props) {
  const [items, setItems] = useState<QueueItem[]>([]);
  // The queue lives in a ref and state is just its mirror for painting: the logic
  // needs to read the current list outside the render cycle, and this way an object
  // already handed to React is never mutated.
  const queue = useRef<QueueItem[]>([]);
  const handles = useRef(new Map<string, UploadHandle>());
  const running = useRef(0);
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  // Options are read when each upload starts, not when it is queued: changing them
  // affects whatever is still pending without rebuilding the queue.
  const optionsRef = useRef({ ttlHours, maxDownloads });

  useEffect(() => {
    optionsRef.current = { ttlHours, maxDownloads };
  }, [ttlHours, maxDownloads]);

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
   * Keeps the screen awake while uploading. On a phone, locking the screen suspends
   * the upload: resuming saves the progress, but forces the user to come back and
   * pick the file again. This avoids that in the first place.
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

  // The system drops the lock when the tab is hidden; it is re-acquired on return.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible" && running.current > 0) {
        void acquireWakeLock();
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [acquireWakeLock]);

  // pump reschedules itself as each upload finishes; the indirection avoids using
  // the constant before it is declared.
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
        ttlHours: optionsRef.current.ttlHours,
        maxDownloads: optionsRef.current.maxDownloads,
        uploadedBy: getUploaderName() || undefined,
        onProgress: ({ loaded, resumed }) => update(key, { loaded, resumed }),
      });
      handles.current.set(key, handle);

      handle.promise
        .then((result) => {
          update(key, { state: "done", result, loaded: file.size });
          toast.success("Uploaded", { description: file.name });
          onCompleted();
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : "Upload failed";
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
          // Start the next one in the queue.
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
          // Stable key even if name and size repeat within the same batch.
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

// ─── Presentation ────────────────────────────────────────────────────
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
    <section aria-label="Upload queue" className="mt-6 space-y-3">
      {items.length > 1 && (
        <div className="rounded-xl border border-border bg-card/60 p-3">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium">
              {active.length > 0
                ? `Uploading ${items.length - active.length + 1} of ${items.length}`
                : `${items.length} files`}
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
                    {item.state === "pending" && "queued"}
                    {item.state === "uploading" &&
                      `${formatBytes(item.loaded)} / ${formatBytes(item.file.size)} · ${pct}%`}
                    {item.state === "done" && formatBytes(item.file.size)}
                    {item.state === "error" && (
                      <span className="text-destructive">{item.error}</span>
                    )}
                    {item.state === "cancelled" && "cancelled"}
                    {item.resumed && item.state === "uploading" && (
                      <span className="text-success"> · resuming</span>
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
                      aria-label={`Cancel ${item.file.name}`}
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
Clear finished
        </button>
      )}
    </section>
  );
}
