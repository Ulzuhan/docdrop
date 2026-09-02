"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, Clock, Download, Flame, Loader2, Save, Share2 } from "lucide-react";
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
import {
  type CabeceraE2EE,
  claveDesdeFragmento,
  descifrarCabecera,
  descifrarFichero,
  leerPrefijo,
} from "@/lib/e2ee";
import {
  FalloFlujo,
  descargaEnFlujoDisponible,
  descargarEnFlujo,
  entornoSinFlujo,
  entradaLlavero,
  esIOS,
} from "@/lib/e2ee-client";

interface FileInfo {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  uploadedAt: number;
  expiresAt: number;
  downloadCount: number;
  maxDownloads: number;
  uploadedBy?: string;
  /** El contenido es un bulto cifrado: el nombre y el tipo de arriba son marcadores. */
  encrypted?: boolean;
  /** El prefijo del bulto en base64: la cabecera cifrada, que solo abre la clave. */
  header?: string;
}

/** Lo que queda en memoria tras descifrar: el fichero, listo para guardarse. */
interface Descifrado {
  blob: Blob;
  url: string;
  nombre: string;
  tipo: string;
}

/** En memoria: por encima de esto se avisa antes de intentarlo. */
const AVISO_MEMORIA = 1.5 * 1024 * 1024 * 1024;

const noopSubscribe = () => () => {};

function desdeBase64(texto: string): Uint8Array {
  const bin = atob(texto);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

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

  // Lo que la clave deja ver antes de descargar: la cabecera cifrada que
  // /api/info trae, abierta aquí. Si la clave no abre la cabecera, tampoco
  // abrirá el fichero, y se dice antes de gastar una descarga en comprobarlo.
  const [cabecera, setCabecera] = useState<CabeceraE2EE | null>(null);
  const [claveMala, setClaveMala] = useState(false);

  // El nombre de verdad si esta persona es quien subió (llavero local), o el
  // que salga de la cabecera o de descifrar.
  const [nombreDescifrado, setNombreDescifrado] = useState<string | null>(null);
  const nombreReal =
    nombreDescifrado ?? cabecera?.name ?? (montado ? entradaLlavero(id)?.name ?? null : null);

  const [fallo, setFallo] = useState<string | null>(null);
  const [listo, setListo] = useState<Descifrado | null>(null);

  // Clock in state: reading Date.now() during render is impure and left the
  // countdown frozen. The initial value never reaches the prerendered HTML because
  // this block only paints once fileInfo is there, fetched on the client.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);

  const cargarInfo = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`/api/info/${id}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "File not found");
        setReason(data.reason ?? null);
        return false;
      }
      setFileInfo(data);
      return true;
    } catch {
      setError("Could not load the file information");
      return false;
    }
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    async function primeraCarga() {
      await cargarInfo();
      if (!cancelled) setLoading(false);
    }
    void primeraCarga();
    return () => {
      cancelled = true;
    };
  }, [cargarInfo]);

  const cifrado = Boolean(fileInfo?.encrypted);
  const claveValida = Boolean(fragmento && claveDesdeFragmento(fragmento));

  // Abrir la cabecera en cuanto hay clave y hay cabecera.
  useEffect(() => {
    if (!fileInfo?.header || !fragmento) return;
    const clave = claveDesdeFragmento(fragmento);
    if (!clave) return;
    let cancelled = false;
    (async () => {
      try {
        const prefijo = leerPrefijo(desdeBase64(fileInfo.header!));
        if (!prefijo) throw new Error("formato");
        const abierta = await descifrarCabecera(clave, prefijo.cabeceraCifrada);
        if (!cancelled) setCabecera(abierta);
      } catch {
        if (!cancelled) setClaveMala(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileInfo?.header, fragmento]);

  // Los blobs se sueltan al desmontar, no antes: un botón de guardar que se
  // pulsa tarde tiene que seguir apuntando a algo.
  useEffect(() => {
    return () => {
      if (listo) URL.revokeObjectURL(listo.url);
    };
  }, [listo]);

  function download() {
    setDownloading(true);
    // Direct navigation: let the browser handle the download (and resume it, since
    // the server supports Range requests).
    window.location.href = `/api/download/${id}`;
    setTimeout(() => setDownloading(false), 2500);
  }

  /** Un código del servidor, dicho como lo que es y no como un fallo de clave. */
  async function explicarEstado(estado: number) {
    if (estado === 410) {
      // Se acabó mientras mirábamos: que la pantalla lo diga con su motivo.
      await cargarInfo();
      return;
    }
    if (estado === 429) {
      setFallo("Too many downloads from your network right now. Try again in a minute.");
      return;
    }
    setFallo(`The server did not send the file (${estado}). Try again in a moment.`);
  }

  /** El fichero descifrado, entregado como descarga o vía la hoja de compartir. */
  function guardar(d: Descifrado) {
    const fichero = new File([d.blob], d.nombre, { type: d.tipo });
    const compartir = typeof navigator.share === "function" &&
      typeof navigator.canShare === "function" &&
      navigator.canShare({ files: [fichero] });
    // En iOS la hoja de compartir es la única forma fiable de «guardar en
    // Fotos» o «guardar en Archivos»; en un navegador incrustado, a veces la
    // única de sacar el fichero de la app. Tiene que llamarse dentro del
    // gesto, así que es un botón y no algo que pasa solo tras descifrar.
    if (compartir && (esIOS() || entornoSinFlujo())) {
      navigator.share({ files: [fichero], title: d.nombre }).catch(() => {
        // Cancelar la hoja no es un fallo. Si de verdad no se puede, queda el enlace de abajo.
      });
      return;
    }
    const a = document.createElement("a");
    a.href = d.url;
    a.download = d.nombre;
    a.click();
  }

  /**
   * El camino cifrado: bajar el bulto, abrirlo AQUÍ y entregar el claro.
   *
   * El servidor solo ve la descarga del bulto, que cuenta cuando ha salido
   * entera; el descifrado y el nombre de verdad ocurren en este navegador con
   * la clave del fragmento. Cualquier manipulación del bulto —un byte, un
   * trozo movido, un recorte— hace saltar el GCM y se dice, no se entrega un
   * fichero a medias.
   */
  async function descargarCifrado() {
    const clave = fragmento ? claveDesdeFragmento(fragmento) : null;
    if (!clave) return;
    setDownloading(true);
    setFallo(null);

    // El camino bueno: descifrar hacia disco vía service worker, sin memoria.
    // Solo donde funciona (Chromium de escritorio y Android; ver
    // entornoSinFlujo) y, si falla antes del primer byte, se cae a memoria:
    // el bulto sigue intacto y no ha nacido ninguna descarga a medias.
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
        if (error instanceof FalloFlujo && error.antesDelPrimerByte) {
          if (error.estado) {
            await explicarEstado(error.estado);
            setDownloading(false);
            return;
          }
          // Sin bytes fuera: probar en memoria es seguro. Sigue abajo.
        } else {
          // Falló a mitad: el navegador ya marcó la descarga como fallida y
          // esto solo añade el porqué.
          setFallo(
            "The download stopped part-way: the stored data does not verify. Ask whoever sent it to upload it again."
          );
          setDownloading(false);
          return;
        }
      }
    }

    try {
      const res = await fetch(`/api/download/${id}`);
      if (!res.ok) {
        await explicarEstado(res.status);
        return;
      }
      const bulto = new Uint8Array(await res.arrayBuffer());
      const abierto = await descifrarFichero(clave, bulto);
      if (!abierto) throw new Error("formato");
      const blob = new Blob([abierto.datos as unknown as ArrayBuffer], { type: abierto.cabecera.mimeType });
      const d: Descifrado = {
        blob,
        url: URL.createObjectURL(blob),
        nombre: abierto.cabecera.name,
        tipo: abierto.cabecera.mimeType,
      };
      setListo(d);
      setNombreDescifrado(d.nombre);
      // Donde una descarga de blob funciona sin más, que salga sola; donde no
      // (iOS, navegadores incrustados), el botón de guardar hace el resto.
      if (!esIOS() && !entornoSinFlujo()) guardar(d);
    } catch {
      setFallo(
        "Could not decrypt this file: the link may be incomplete, or the stored data does not verify. Nothing was delivered."
      );
    } finally {
      setDownloading(false);
    }
  }

  const expired = fileInfo ? fileInfo.expiresAt <= now : false;
  const nombreMostrado = cifrado ? nombreReal ?? "Encrypted file" : fileInfo?.originalName ?? "";
  const tipoMostrado = cifrado ? cabecera?.mimeType ?? fileInfo?.mimeType ?? "" : fileInfo?.mimeType ?? "";
  const tamanoMostrado = cifrado ? cabecera?.size ?? fileInfo?.size ?? 0 : fileInfo?.size ?? 0;
  const enMemoria = cifrado && claveValida && !descargaEnFlujoDisponible();

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
                {cifrado && !cabecera && !nombreDescifrado ? "🔒" : fileEmoji(tipoMostrado, nombreMostrado)}
              </span>
              <h1
                className="mt-4 text-xl font-semibold tracking-tight break-words text-balance sm:text-2xl"
                title={nombreMostrado}
              >
                {nombreMostrado}
              </h1>
              {cifrado && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {cabecera
                    ? "Encrypted in the sender's browser. This link holds the key; the server never had it."
                    : "Encrypted in the sender's browser — this server cannot read it."}
                </p>
              )}
              {fileInfo.uploadedBy && (
                <p className="mt-1 text-xs text-muted-foreground">from {fileInfo.uploadedBy}</p>
              )}
              <p className="mt-1 text-sm tabular-nums text-muted-foreground">
                {formatBytes(tamanoMostrado)}
              </p>
            </div>

            {/* Preview: look before downloading several GB. Served with ?inline=1,
                which consumes no downloads and only allows types that cannot run
                scripts in this origin. Encrypted files preview after decrypting,
                from the bytes already paid for, further down. */}
            {!expired && !cifrado && fileInfo.mimeType.startsWith("video/") && (
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

            {!expired && !cifrado && fileInfo.mimeType.startsWith("audio/") && (
              <audio controls className="mt-6 w-full" src={`/api/download/${id}?inline=1`}>
Your browser cannot play this audio.
              </audio>
            )}

            {!expired &&
              !cifrado &&
              fileInfo.mimeType.startsWith("image/") &&
              fileInfo.mimeType !== "image/svg+xml" && (
                // eslint-disable-next-line @next/next/no-img-element -- served by the app itself, unoptimised
                <img
                  src={`/api/download/${id}?inline=1`}
                  alt={fileInfo.originalName}
                  className="mt-6 w-full rounded-2xl border border-border bg-card object-contain"
                />
              )}

            {listo && listo.tipo.startsWith("image/") && listo.tipo !== "image/svg+xml" && (
              // eslint-disable-next-line @next/next/no-img-element -- a blob decrypted in this browser
              <img
                src={listo.url}
                alt={listo.nombre}
                className="mt-6 w-full rounded-2xl border border-border bg-card object-contain"
              />
            )}
            {listo && listo.tipo.startsWith("video/") && (
              <video controls playsInline className="mt-6 w-full rounded-2xl border border-border bg-black" src={listo.url} />
            )}
            {listo && listo.tipo.startsWith("audio/") && (
              <audio controls className="mt-6 w-full" src={listo.url} />
            )}

            <div className="mt-6 rounded-2xl border border-border bg-card/70 p-4 sm:p-5">
              <dl className="space-y-3 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Type</dt>
                  <dd className="truncate font-mono text-xs">{tipoMostrado}</dd>
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
              // El enlace llegó sin su mitad secreta. Decir exactamente eso, y
              // qué tiene que hacer quien lo mandó: el servidor no puede
              // reponerla porque nunca la tuvo.
              <div className="mt-6 rounded-xl border border-warning/30 bg-warning/5 p-4 text-sm text-muted-foreground">
                <p className="font-medium text-foreground">This link is missing its key</p>
                <p className="mt-1">
                  The key is the part after <span className="font-mono">#</span>, and it did not
                  arrive. The server never had it and cannot recover it.
                </p>
                <p className="mt-2">
                  Ask whoever sent it to copy the link again <strong>from the browser they uploaded
                  with</strong> — the key only exists there — and to send it whole.
                </p>
              </div>
            ) : cifrado && claveMala ? (
              <p className="mt-6 rounded-xl border border-destructive/25 bg-destructive/5 p-3 text-center text-sm text-destructive">
The key in this link does not open this file. The link is probably incomplete or altered;
ask whoever sent it for it again, whole.
              </p>
            ) : listo ? (
              <div className="mt-6 space-y-2">
                <Button size="lg" className="h-12 w-full text-base" onClick={() => guardar(listo)}>
                  {esIOS() || entornoSinFlujo() ? (
                    <Share2 className="size-5" aria-hidden />
                  ) : (
                    <Save className="size-5" aria-hidden />
                  )}
                  Save {listo.nombre}
                </Button>
                <p className="text-center text-xs text-muted-foreground">
                  Decrypted in this browser.{" "}
                  <a href={listo.url} download={listo.nombre} className="underline underline-offset-4">
                    Or open it directly.
                  </a>
                </p>
              </div>
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
                  title={nombreMostrado}
                  className="size-12 shrink-0"
                />
                <QrDialog
                  path={`/d/${id}${cifrado && fragmento ? fragmento : ""}`}
                  filename={nombreMostrado}
                />
              </div>
            )}

            {fallo && (
              <p className="mt-3 rounded-xl border border-destructive/25 bg-destructive/5 p-3 text-center text-sm text-destructive">
                {fallo}
              </p>
            )}

            {enMemoria && !listo && tamanoMostrado > AVISO_MEMORIA && (
              <p className="mt-3 text-center text-xs text-muted-foreground">
This browser decrypts in memory and this file is large; on a phone it may run out.
A desktop browser decrypts straight to disk.
              </p>
            )}

            {fileInfo.maxDownloads > 0 && !expired && !listo && (
              <p className="mt-3 text-center text-xs text-muted-foreground">
                {fileInfo.maxDownloads - fileInfo.downloadCount} downloads left before it is
                deleted. A download counts once it has fully arrived.
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
