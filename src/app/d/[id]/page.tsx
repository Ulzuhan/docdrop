"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
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
import { claveDesdeFragmento, descifrarFichero } from "@/lib/e2ee";
import { descargaEnFlujoDisponible, descargarEnFlujo, entradaLlavero } from "@/lib/e2ee-client";

interface FileInfo {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  uploadedAt: number;
  expiresAt: number;
  downloadCount: number;
  maxDownloads: number;
  /** El contenido es un bulto cifrado: el nombre y el tipo de arriba son marcadores. */
  encrypted?: boolean;
}

/** En memoria de momento: por encima de esto se avisa antes de intentarlo. */
const AVISO_MEMORIA = 1.5 * 1024 * 1024 * 1024;

const noopSubscribe = () => () => {};

export default function DownloadPage() {
  const params = useParams();
  const id = params.id as string;

  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  // La mitad del enlace que el servidor nunca vio: el fragmento. Solo existe en
  // el navegador (los fragmentos no viajan en la petición), así que en el
  // servidor se lee como null y el cliente lo resuelve al hidratar — el mismo
  // patrón que usa el resto del repo para lo que solo el navegador sabe.
  const montado = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
  const fragmento = montado ? window.location.hash || null : null;
  // El nombre de verdad si esta persona es quien subió (llavero local), o el que
  // salga de descifrar. El llavero se lee en el render una vez montado: es
  // lectura pura de localStorage, no una sincronización que pida un efecto.
  const [nombreDescifrado, setNombreDescifrado] = useState<string | null>(null);
  const nombreReal = nombreDescifrado ?? (montado ? entradaLlavero(id)?.name ?? null : null);
  const [falloDescifrado, setFalloDescifrado] = useState<string | null>(null);
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

  /**
   * El camino cifrado: bajar el bulto, abrirlo AQUÍ y entregar el claro.
   *
   * El servidor solo ve la descarga del bulto (que cuenta como descarga, igual
   * que siempre); el descifrado y el nombre de verdad ocurren en este navegador
   * con la clave del fragmento. Cualquier manipulación del bulto —un byte, un
   * trozo movido, un recorte— hace saltar el GCM y se dice, no se entrega un
   * fichero a medias.
   */
  async function descargarCifrado() {
    const clave = fragmento ? claveDesdeFragmento(fragmento) : null;
    if (!clave) return;
    setDownloading(true);
    setFalloDescifrado(null);

    // El camino bueno: descifrar hacia disco vía service worker, sin memoria.
    // Si este navegador no lo aguanta (Safari, contexto sin SW), se cae al
    // camino en memoria de abajo — mismo resultado, otro coste.
    if (descargaEnFlujoDisponible()) {
      try {
        const { nombre } = await descargarEnFlujo(id, clave);
        setNombreDescifrado(nombre);
        setDownloading(false);
        return;
      } catch (error) {
        if (error instanceof Error && error.message === "cancelled") {
          setDownloading(false);
          return;
        }
        // Antes de emitir bytes no hay descarga nacida: probar en memoria es
        // seguro. Si falló a mitad, el navegador ya marcó la descarga como
        // fallida y esto solo añade el porqué.
        setFalloDescifrado(
          "Could not decrypt this file. The link may be incomplete, or the stored data does not verify."
        );
        setDownloading(false);
        return;
      }
    }

    try {
      const res = await fetch(`/api/download/${id}`);
      if (!res.ok) throw new Error(`download ${res.status}`);
      const bulto = new Uint8Array(await res.arrayBuffer());
      const abierto = await descifrarFichero(clave, bulto);
      if (!abierto) throw new Error("formato");
      const blob = new Blob([abierto.datos as unknown as ArrayBuffer], { type: abierto.cabecera.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = abierto.cabecera.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setNombreDescifrado(abierto.cabecera.name);
    } catch {
      // Sin distinguir causas hacia fuera: o el enlace está mal, o el bulto fue
      // manipulado. En ambos casos lo honesto es no entregar nada.
      setFalloDescifrado(
        "Could not decrypt this file. The link may be incomplete, or the stored data does not verify."
      );
    } finally {
      setDownloading(false);
    }
  }

  const cifrado = Boolean(fileInfo?.encrypted);
  const claveValida = Boolean(fragmento && claveDesdeFragmento(fragmento));

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
                title={cifrado ? undefined : fileInfo.originalName}
              >
                {cifrado ? nombreReal ?? "Encrypted file" : fileInfo.originalName}
              </h1>
              {cifrado && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Encrypted in the sender&apos;s browser — this server cannot read it.
                </p>
              )}
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
            ) : cifrado && !claveValida ? (
              // El enlace llegó sin su mitad secreta. Decir exactamente eso: el
              // servidor no puede reponerla porque nunca la tuvo.
              <p className="mt-6 rounded-xl border border-warning/30 bg-warning/5 p-3 text-center text-sm text-muted-foreground">
This link is missing its key — the part after <span className="font-mono">#</span>.
Ask whoever sent it for the complete link; the server never had the key and cannot
recover it.
              </p>
            ) : (
              <div className="mt-6 flex items-center gap-2">
                <Button
                  size="lg"
                  className="h-12 flex-1 text-base"
                  onClick={cifrado ? descargarCifrado : download}
                  disabled={downloading}
                >
                  {downloading ? (
                    <Loader2 className="size-5 animate-spin" aria-hidden />
                  ) : (
                    <Download className="size-5" aria-hidden />
                  )}
                  {downloading ? (cifrado ? "Decrypting…" : "Starting…") : "Download"}
                </Button>
                {/* Forward the link to someone else without going back to the dashboard.
                    Con cifrado, el fragmento viaja en lo que se comparte: sin él, el
                    enlace no abre nada. */}
                <ShareButton
                  path={`/d/${id}${cifrado && fragmento ? fragmento : ""}`}
                  title={cifrado ? nombreReal ?? "Encrypted file" : fileInfo.originalName}
                  className="size-12 shrink-0"
                />
                <QrDialog
                  path={`/d/${id}${cifrado && fragmento ? fragmento : ""}`}
                  filename={cifrado ? nombreReal ?? "Encrypted file" : fileInfo.originalName}
                />
              </div>
            )}

            {falloDescifrado && (
              <p className="mt-3 rounded-xl border border-destructive/25 bg-destructive/5 p-3 text-center text-sm text-destructive">
                {falloDescifrado}
              </p>
            )}

            {cifrado && claveValida && !expired && fileInfo.size > AVISO_MEMORIA && (
              <p className="mt-3 text-center text-xs text-muted-foreground">
Decryption happens in this browser and this file is large; on low-memory devices it
may fail. A streaming path is coming.
              </p>
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
