"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, Clock, Download, Flame, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { SiteHeader } from "@/components/site-header";
import { ShareButton } from "@/components/share-button";
import { QrDialog } from "@/components/qr-dialog";
import {
  fileEmoji,
  formatBytes,
  formatDateTime,
  formatRemaining,
} from "@/lib/format";

interface FileInfo {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  uploadedAt: number;
  expiresAt: number;
  downloadCount: number;
  maxDownloads: number;
}

export default function DownloadPage() {
  const params = useParams();
  const id = params.id as string;

  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  // Clock in state: reading Date.now() during render is impure and left the
  // countdown frozen. The initial value never reaches the prerendered HTML because
  // this block only paints once fileInfo is there, fetched on the client.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function fetchInfo() {
      try {
        const res = await fetch(`/api/info/${id}`);
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;

        if (!res.ok) {
          setError(data.error || "File not found");
          setReason(data.reason ?? null);
          return;
        }
        setFileInfo(data);
      } catch {
        if (!cancelled) setError("Could not load the file information");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchInfo();
    return () => {
      cancelled = true;
    };
  }, [id]);

  function download() {
    setDownloading(true);
    // Direct navigation: let the browser handle the download (and resume it, since
    // the server supports Range requests).
    window.location.href = `/api/download/${id}`;
    setTimeout(() => setDownloading(false), 2500);
  }

  const expired = fileInfo ? fileInfo.expiresAt <= now : false;

  return (
    <>
      <SiteHeader />

      <main className="mx-auto flex w-full max-w-md flex-1 items-center justify-center px-4 py-10 pb-safe sm:py-16">
        {loading ? (
          <div className="w-full space-y-4">
            <Skeleton className="mx-auto size-16 rounded-2xl" />
            <Skeleton className="mx-auto h-6 w-3/4" />
            <Skeleton className="h-32 w-full rounded-xl" />
            <Skeleton className="h-12 w-full rounded-xl" />
          </div>
        ) : error ? (
          <div className="w-full rounded-2xl border border-border bg-card/70 p-8 text-center">
            <span
              aria-hidden
              className={`mx-auto grid size-14 place-items-center rounded-2xl ring-1 ${
                reason === "exhausted"
                  ? "bg-warning/10 text-warning ring-warning/25"
                  : "bg-destructive/10 text-destructive ring-destructive/25"
              }`}
            >
              {reason === "exhausted" ? (
                <Flame className="size-6" />
              ) : (
                <AlertTriangle className="size-6" />
              )}
            </span>

            <h1 className="mt-4 text-xl font-semibold tracking-tight">
              {reason === "exhausted"
                ? "This file has been used up"
                : reason === "expired"
                  ? "This link has expired"
                  : "File not available"}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground text-balance">
              {reason
                ? "Files delete themselves once they expire or run out of downloads. Ask whoever sent it to upload it again."
                : error}
            </p>

            <Button render={<Link href="/" />} variant="outline" className="mt-6 h-11 w-full">
Go to DocDrop
            </Button>
          </div>
        ) : fileInfo ? (
          <div className="w-full">
            <div className="text-center">
              <span aria-hidden className="text-5xl sm:text-6xl">
                {fileEmoji(fileInfo.mimeType, fileInfo.originalName)}
              </span>
              <h1
                className="mt-4 text-xl font-semibold tracking-tight break-words text-balance sm:text-2xl"
                title={fileInfo.originalName}
              >
                {fileInfo.originalName}
              </h1>
              <p className="mt-1 text-sm tabular-nums text-muted-foreground">
                {formatBytes(fileInfo.size)}
              </p>
            </div>

            {/* Preview: look before downloading several GB. Served with ?inline=1,
                which consumes no downloads and only allows types that cannot run
                scripts in this origin. */}
            {!expired && fileInfo.mimeType.startsWith("video/") && (
              <video
                controls
                preload="metadata"
                playsInline
                className="mt-6 w-full rounded-2xl border border-border bg-black"
                src={`/api/download/${id}?inline=1`}
              >
Your browser cannot play this video.
              </video>
            )}

            {!expired && fileInfo.mimeType.startsWith("audio/") && (
              <audio controls className="mt-6 w-full" src={`/api/download/${id}?inline=1`}>
Your browser cannot play this audio.
              </audio>
            )}

            {!expired &&
              fileInfo.mimeType.startsWith("image/") &&
              fileInfo.mimeType !== "image/svg+xml" && (
                // eslint-disable-next-line @next/next/no-img-element -- served by the app itself, unoptimised
                <img
                  src={`/api/download/${id}?inline=1`}
                  alt={fileInfo.originalName}
                  className="mt-6 w-full rounded-2xl border border-border bg-card object-contain"
                />
              )}

            <div className="mt-6 rounded-2xl border border-border bg-card/70 p-4 sm:p-5">
              <dl className="space-y-3 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Type</dt>
                  <dd className="truncate font-mono text-xs">{fileInfo.mimeType}</dd>
                </div>
                <Separator />
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Uploaded</dt>
                  <dd className="text-right">{formatDateTime(fileInfo.uploadedAt)}</dd>
                </div>
                <Separator />
                <div className="flex items-center justify-between gap-4">
                  <dt className="flex items-center gap-1.5 text-muted-foreground">
                    <Clock className="size-3.5" aria-hidden />
Expires
                  </dt>
                  <dd className={expired ? "font-medium text-destructive" : "font-medium text-success"}>
                    {expired ? "expired" : `in ${formatRemaining(fileInfo.expiresAt, now)}`}
                  </dd>
                </div>
                {fileInfo.maxDownloads > 0 && (
                  <>
                    <Separator />
                    <div className="flex items-center justify-between gap-4">
                      <dt className="text-muted-foreground">Downloads</dt>
                      <dd className="tabular-nums">
                        {fileInfo.downloadCount} of {fileInfo.maxDownloads}
                      </dd>
                    </div>
                  </>
                )}
              </dl>
            </div>

            {expired ? (
              <p className="mt-6 rounded-xl border border-destructive/25 bg-destructive/5 p-3 text-center text-sm text-destructive">
This file has expired and is no longer available.
              </p>
            ) : (
              <div className="mt-6 flex items-center gap-2">
                <Button size="lg" className="h-12 flex-1 text-base" onClick={download}>
                  {downloading ? (
                    <Loader2 className="size-5 animate-spin" aria-hidden />
                  ) : (
                    <Download className="size-5" aria-hidden />
                  )}
                  {downloading ? "Starting…" : "Download"}
                </Button>
                {/* Forward the link to someone else without going back to the dashboard. */}
                <ShareButton
                  path={`/d/${id}`}
                  title={fileInfo.originalName}
                  className="size-12 shrink-0"
                />
                <QrDialog path={`/d/${id}`} filename={fileInfo.originalName} />
              </div>
            )}

            {fileInfo.maxDownloads > 0 && !expired && (
              <p className="mt-3 text-center text-xs text-muted-foreground">
                {fileInfo.maxDownloads - fileInfo.downloadCount} downloads left before it is
                deleted.
              </p>
            )}

            <p className="mt-8 text-center text-xs text-muted-foreground">
              <Link href="/" className="underline-offset-4 hover:text-foreground hover:underline">
Share your own files with DocDrop
              </Link>
            </p>
          </div>
        ) : null}
      </main>
    </>
  );
}
