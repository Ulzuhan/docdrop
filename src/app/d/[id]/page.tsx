"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, Clock, Download, Flame, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { SiteHeader } from "@/components/site-header";
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
  // Reloj en estado: leer Date.now() en el render es impuro y dejaba la cuenta
  // atrás congelada. El valor inicial no llega al HTML prerenderizado porque este
  // bloque solo se pinta cuando ya hay fileInfo, que llega por fetch en el cliente.
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
          setError(data.error || "Fichero no encontrado");
          setReason(data.reason ?? null);
          return;
        }
        setFileInfo(data);
      } catch {
        if (!cancelled) setError("No se pudo cargar la información del fichero");
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
    // Navegación directa: deja que el navegador gestione la descarga (y permite
    // reanudarla, porque el servidor admite peticiones Range).
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
                ? "Este fichero ya se consumió"
                : reason === "expired"
                  ? "Este enlace ha caducado"
                  : "Fichero no disponible"}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground text-balance">
              {reason
                ? "Los ficheros se borran solos al caducar o al agotar sus descargas. Pide a quien te lo envió que vuelva a subirlo."
                : error}
            </p>

            <Button render={<Link href="/" />} variant="outline" className="mt-6 h-11 w-full">
              Ir a DocDrop
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

            <div className="mt-6 rounded-2xl border border-border bg-card/70 p-4 sm:p-5">
              <dl className="space-y-3 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Tipo</dt>
                  <dd className="truncate font-mono text-xs">{fileInfo.mimeType}</dd>
                </div>
                <Separator />
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Subido</dt>
                  <dd className="text-right">{formatDateTime(fileInfo.uploadedAt)}</dd>
                </div>
                <Separator />
                <div className="flex items-center justify-between gap-4">
                  <dt className="flex items-center gap-1.5 text-muted-foreground">
                    <Clock className="size-3.5" aria-hidden />
                    Caduca
                  </dt>
                  <dd className={expired ? "font-medium text-destructive" : "font-medium text-success"}>
                    {expired ? "caducado" : `en ${formatRemaining(fileInfo.expiresAt, now)}`}
                  </dd>
                </div>
                {fileInfo.maxDownloads > 0 && (
                  <>
                    <Separator />
                    <div className="flex items-center justify-between gap-4">
                      <dt className="text-muted-foreground">Descargas</dt>
                      <dd className="tabular-nums">
                        {fileInfo.downloadCount} de {fileInfo.maxDownloads}
                      </dd>
                    </div>
                  </>
                )}
              </dl>
            </div>

            {expired ? (
              <p className="mt-6 rounded-xl border border-destructive/25 bg-destructive/5 p-3 text-center text-sm text-destructive">
                Este fichero ha caducado y ya no está disponible.
              </p>
            ) : (
              <Button size="lg" className="mt-6 h-12 w-full text-base" onClick={download}>
                {downloading ? (
                  <Loader2 className="size-5 animate-spin" aria-hidden />
                ) : (
                  <Download className="size-5" aria-hidden />
                )}
                {downloading ? "Empezando…" : "Descargar"}
              </Button>
            )}

            {fileInfo.maxDownloads > 0 && !expired && (
              <p className="mt-3 text-center text-xs text-muted-foreground">
                Quedan {fileInfo.maxDownloads - fileInfo.downloadCount} descargas antes de que
                se borre.
              </p>
            )}

            <p className="mt-8 text-center text-xs text-muted-foreground">
              <Link href="/" className="underline-offset-4 hover:text-foreground hover:underline">
                Comparte tus propios ficheros con DocDrop
              </Link>
            </p>
          </div>
        ) : null}
      </main>
    </>
  );
}
