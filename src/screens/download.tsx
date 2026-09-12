import { useCallback, useEffect, useState } from "react";
import { Download, Flame, KeyRound, Loader, Lock, Save, Share2, ShieldAlert, Clock } from "lucide-react";
import { Header } from "@/components/header";
import { Button, LinkButton } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { FileIcon } from "@/components/file-icon";
import { QrButton, ShareButton } from "@/components/link-actions";
import { fetchFileInfo, type PublicFileInfo } from "@/lib/api";
import { type CabeceraE2EE, claveDesdeFragmento, descifrarCabecera, descifrarFichero, leerPrefijo } from "@/lib/e2ee";
import {
  FalloFlujo,
  descargaEnFlujoDisponible,
  descargarEnFlujo,
  entornoSinFlujo,
  entradaLlavero,
  esIOS,
} from "@/lib/e2ee-client";
import { fileKind } from "@/lib/file-kind";
import { formatBytes, formatDateTime, formatRemainingLong } from "@/lib/format";
import { routeParams } from "@/lib/navigation";
import { useNow } from "@/lib/use-now";

/** What stays in memory after decrypting: the file, ready to be saved. */
interface Decrypted {
  blob: Blob;
  url: string;
  name: string;
  type: string;
}

type State =
  | { status: "loading" }
  | { status: "error"; error: string; reason: "expired" | "exhausted" | null }
  | { status: "ready"; info: PublicFileInfo };

/** In memory: above this, the page warns before trying. */
const MEMORY_WARNING = 1.5 * 1024 * 1024 * 1024;

function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function isMedia(type: string, family: "image" | "video" | "audio"): boolean {
  return type.startsWith(`${family}/`) && type !== "image/svg+xml";
}

/**
 * The download page, /d/<id>.
 *
 * For an encrypted file the key is the fragment of the URL: the part the
 * browser never sends to any server. With it, the encrypted header from
 * /api/info opens here and shows the real name before a download is spent; the
 * file itself is decrypted in this browser, streamed to disk where the browser
 * allows it and in memory where it does not.
 */
export function DownloadPage() {
  const { id } = routeParams();
  const [state, setState] = useState<State>({ status: "loading" });
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [fragment] = useState(() => window.location.hash || null);
  const [header, setHeader] = useState<CabeceraE2EE | null>(null);
  const [badKey, setBadKey] = useState(false);
  const [keyringName] = useState(() => entradaLlavero(id)?.name ?? null);
  const [decryptedName, setDecryptedName] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [ready, setReady] = useState<Decrypted | null>(null);
  const now = useNow();

  const load = useCallback(async () => {
    const result = await fetchFileInfo(id);
    if (result.ok) setState({ status: "ready", info: result.info });
    else setState({ status: "error", error: result.error, reason: result.reason });
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const info = state.status === "ready" ? state.info : null;
  const encrypted = Boolean(info?.encrypted);
  const key = fragment ? claveDesdeFragmento(fragment) : null;

  // Open the header as soon as there is a key and a header. If the key does not
  // open the header it will not open the file either, and that is said before a
  // download is spent finding out.
  useEffect(() => {
    if (!info?.header || !fragment) return;
    const k = claveDesdeFragmento(fragment);
    if (!k) return;
    let cancelled = false;
    (async () => {
      try {
        const prefix = leerPrefijo(fromBase64(info.header!));
        if (!prefix) throw new Error("format");
        const opened = await descifrarCabecera(k, prefix.cabeceraCifrada);
        if (!cancelled) setHeader(opened);
      } catch {
        if (!cancelled) setBadKey(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [info?.header, fragment]);

  // Blobs are released on unmount, not before: a save button pressed late has
  // to still point at something.
  useEffect(() => {
    return () => {
      if (ready) URL.revokeObjectURL(ready.url);
    };
  }, [ready]);

  function downloadPlain() {
    setDownloading(true);
    // Direct navigation: the browser handles the download and can resume it,
    // since the server supports Range requests.
    window.location.href = `/api/download/${id}`;
    setTimeout(() => setDownloading(false), 2500);
  }

  /** A server status, said as what it is and not as a key problem. */
  async function explain(status: number) {
    if (status === 410) {
      await load();
      return;
    }
    if (status === 429) {
      setFailure("Too many downloads from your network right now. Try again in a minute.");
      return;
    }
    setFailure(`The server did not send the file (${status}). Try again in a moment.`);
  }

  /** The decrypted file, handed over as a download or through the share sheet. */
  function save(d: Decrypted) {
    const file = new File([d.blob], d.name, { type: d.type });
    const canShare =
      typeof navigator.share === "function" &&
      typeof navigator.canShare === "function" &&
      navigator.canShare({ files: [file] });
    // On iOS the share sheet is the only reliable "save to Photos" or "save to
    // Files"; in an embedded browser, sometimes the only way out of the app.
    if (canShare && (esIOS() || entornoSinFlujo())) {
      navigator.share({ files: [file], title: d.name }).catch(() => {
        // Cancelling the sheet is not a failure; the direct link below remains.
      });
      return;
    }
    const a = document.createElement("a");
    a.href = d.url;
    a.download = d.name;
    a.click();
  }

  /**
   * The encrypted path: fetch the bundle, open it HERE, hand over the plain file.
   * Any tampering with the bundle trips the authentication and is reported;
   * a half file is never delivered.
   */
  async function downloadEncrypted() {
    if (!key) return;
    setDownloading(true);
    setFailure(null);
    setProgress(null);

    // The good path: decrypt to disk through the service worker, no memory.
    // If it fails before the first byte, fall back to memory: the bundle is
    // intact and no half download was born.
    if (descargaEnFlujoDisponible()) {
      try {
        const { nombre } = await descargarEnFlujo(id, key, (done, total) => setProgress({ done, total }));
        setDecryptedName(nombre);
        setDownloading(false);
        setProgress(null);
        return;
      } catch (error) {
        setProgress(null);
        if (error instanceof Error && error.message === "cancelled") {
          setDownloading(false);
          return;
        }
        if (error instanceof FalloFlujo && error.antesDelPrimerByte) {
          if (error.estado) {
            await explain(error.estado);
            setDownloading(false);
            return;
          }
          // No bytes out: trying in memory is safe. Continue below.
        } else {
          setFailure("The download stopped part-way: the stored data does not verify. Ask whoever sent it to upload it again.");
          setDownloading(false);
          return;
        }
      }
    }

    try {
      const res = await fetch(`/api/download/${id}`);
      if (!res.ok) {
        await explain(res.status);
        return;
      }
      const bundle = new Uint8Array(await res.arrayBuffer());
      const opened = await descifrarFichero(key, bundle);
      if (!opened) throw new Error("format");
      const blob = new Blob([opened.datos as unknown as ArrayBuffer], { type: opened.cabecera.mimeType });
      const d: Decrypted = {
        blob,
        url: URL.createObjectURL(blob),
        name: opened.cabecera.name,
        type: opened.cabecera.mimeType,
      };
      setReady(d);
      setDecryptedName(d.name);
      // Where a blob download just works, let it go; where it does not (iOS,
      // embedded browsers), the save button does the rest.
      if (!esIOS() && !entornoSinFlujo()) save(d);
    } catch {
      setFailure("Could not decrypt this file: the link may be incomplete, or the stored data does not verify. Nothing was delivered.");
    } finally {
      setDownloading(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────

  if (state.status === "loading") {
    return (
      <>
        <Header />
        <main className="container-sm dl pb-safe" aria-busy="true">
          <div className="dl-hero">
            <Skeleton style={{ width: 76, height: 76, borderRadius: 22 }} />
            <Skeleton style={{ width: "70%", height: 28 }} />
            <Skeleton style={{ width: "40%", height: 16 }} />
          </div>
          <Skeleton style={{ height: 150, borderRadius: 16 }} />
          <Skeleton style={{ height: 50, borderRadius: 14 }} />
        </main>
      </>
    );
  }

  if (state.status === "error") {
    const { reason, error } = state;
    return (
      <>
        <Header />
        <main className="container-sm dl pb-safe">
          <div className="card state rise">
            <FileIcon kind="file" size="lg" />
            <h1>
              {reason === "exhausted"
                ? "This file has been used up"
                : reason === "expired"
                  ? "This link has expired"
                  : "File not available"}
            </h1>
            <p>
              {reason
                ? "Files delete themselves once they expire or run out of downloads. Ask whoever sent it to upload it again."
                : error}
            </p>
            <span className="badge" data-tone="danger">
              <Flame aria-hidden />
              {reason === "exhausted" ? "Download limit reached" : reason === "expired" ? "Expired" : "Not found"}
            </span>
            <LinkButton href="/" variant="outline">
              Go to DocDrop
            </LinkButton>
          </div>
        </main>
      </>
    );
  }

  const file = state.info;
  const expired = file.expiresAt <= now;
  const realName = decryptedName ?? header?.name ?? keyringName;
  const shownName = encrypted ? (realName ?? "Encrypted file") : file.originalName;
  const shownType = encrypted ? (header?.mimeType ?? "") : file.mimeType;
  const shownSize = encrypted ? (header?.size ?? file.size) : file.size;
  const inMemory = encrypted && Boolean(key) && !descargaEnFlujoDisponible();
  const sharePath = `/d/${id}${encrypted && fragment ? fragment : ""}`;
  const kind = encrypted && !realName ? "encrypted" : fileKind(shownType, shownName);
  const downloadsLeft = file.maxDownloads > 0 ? file.maxDownloads - file.downloadCount : null;

  return (
    <>
      <Header />
      <main className="container-sm dl pb-safe">
        <div className="dl-hero rise">
          <FileIcon kind={kind} size="lg" />
          <h1 title={shownName}>{shownName}</h1>
          <div className="sub">
            {encrypted && (
              <span className="badge" data-tone="ice">
                <Lock aria-hidden />
                End-to-end encrypted
              </span>
            )}
            <span className="size">{formatBytes(shownSize)}</span>
            {file.uploadedBy && <span>from {file.uploadedBy}</span>}
          </div>
          {encrypted && (
            <p className="dl-fine">
              {header
                ? "Encrypted in the sender's browser. This link holds the key; the server never had it."
                : "Encrypted in the sender's browser — this server cannot read it."}
            </p>
          )}
        </div>

        {/* Preview: look before downloading several GB. Served with ?inline=1,
            which spends no downloads and only allows types that cannot run
            scripts in this origin. Encrypted files preview after decrypting. */}
        {!expired && !encrypted && isMedia(file.mimeType, "video") && (
          <video controls preload="metadata" playsInline className="preview" src={`/api/download/${id}?inline=1`} />
        )}
        {!expired && !encrypted && isMedia(file.mimeType, "audio") && (
          <audio controls className="preview" src={`/api/download/${id}?inline=1`} />
        )}
        {!expired && !encrypted && isMedia(file.mimeType, "image") && (
          <img src={`/api/download/${id}?inline=1`} alt={file.originalName} className="preview preview-img" />
        )}
        {ready && isMedia(ready.type, "image") && <img src={ready.url} alt={ready.name} className="preview preview-img" />}
        {ready && isMedia(ready.type, "video") && <video controls playsInline className="preview" src={ready.url} />}
        {ready && isMedia(ready.type, "audio") && <audio controls className="preview" src={ready.url} />}

        <dl className="meta">
          <div>
            <dt>Type</dt>
            <dd className="mono">{shownType || "unknown until decrypted"}</dd>
          </div>
          <div>
            <dt>
              <Clock aria-hidden />
              Uploaded
            </dt>
            <dd>{formatDateTime(file.uploadedAt)}</dd>
          </div>
          <div>
            <dt>
              <Flame aria-hidden />
              Expires
            </dt>
            <dd className={expired ? "danger" : "ok"}>{expired ? "expired" : `in ${formatRemainingLong(file.expiresAt, now)}`}</dd>
          </div>
          <div>
            <dt>
              <Download aria-hidden />
              Downloads
            </dt>
            <dd>{file.maxDownloads > 0 ? `${file.downloadCount} of ${file.maxDownloads} used` : "No limit"}</dd>
          </div>
        </dl>

        {expired ? (
          <div className="note" data-tone="danger">
            <p className="note-title">
              <Flame aria-hidden />
              This file has expired
            </p>
            <p>It is no longer available. Ask whoever sent it to upload it again.</p>
          </div>
        ) : encrypted && !key ? (
          // The link arrived without its secret half. Say exactly that, and what
          // whoever sent it has to do: the server cannot restore what it never had.
          <div className="note" data-tone="warn">
            <p className="note-title">
              <KeyRound aria-hidden />
              This link is missing its key
            </p>
            <p>
              The key is the part after <code>#</code>, and it did not arrive. The server never had it and cannot
              recover it.
            </p>
            <p>
              Ask whoever sent it to copy the link again <strong>from the browser they uploaded with</strong> — the
              key only exists there — and to send it whole.
            </p>
          </div>
        ) : encrypted && badKey ? (
          <div className="note" data-tone="danger">
            <p className="note-title">
              <ShieldAlert aria-hidden />
              The key in this link does not open this file
            </p>
            <p>The link is probably incomplete or altered. Ask whoever sent it for it again, whole.</p>
          </div>
        ) : ready ? (
          <div>
            <Button variant="primary" size="lg" block onClick={() => save(ready)}>
              {esIOS() || entornoSinFlujo() ? <Share2 /> : <Save />}
              Save {ready.name}
            </Button>
            <p className="dl-fine" style={{ marginTop: 10 }}>
              Decrypted in this browser.{" "}
              <a href={ready.url} download={ready.name} style={{ textDecoration: "underline" }}>
                Or open it directly.
              </a>
            </p>
          </div>
        ) : (
          <div className="dl-actions">
            <Button variant="primary" size="lg" onClick={encrypted ? downloadEncrypted : downloadPlain} disabled={downloading}>
              {downloading ? <Loader className="spin" /> : <Download />}
              {downloading ? (encrypted ? "Decrypting…" : "Starting…") : "Download"}
            </Button>
            {/* Forward the link without going back to the dashboard. With
                encryption the fragment travels in what is shared: without it
                the link opens nothing. */}
            <ShareButton path={sharePath} title={shownName} size="icon-lg" variant="secondary" />
            <QrButton path={sharePath} filename={shownName} size="icon-lg" variant="secondary" />
          </div>
        )}

        {downloading && encrypted && (
          <div className="card dl-progress">
            <div className="dl-progress-row">
              <Lock size={14} aria-hidden style={{ color: "var(--ice-text)" }} />
              <span>{progress ? "Decrypting straight to disk" : "Fetching and decrypting"}</span>
              {progress && (
                <span className="num">
                  {formatBytes(progress.done)} / {formatBytes(progress.total)}
                </span>
              )}
            </div>
            <Progress
              value={progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0}
              indeterminate={!progress}
              live
              tone="ice"
              label="Decryption progress"
            />
          </div>
        )}

        {failure && (
          <div className="note" data-tone="danger" role="alert">
            <p>{failure}</p>
          </div>
        )}

        {inMemory && !ready && shownSize > MEMORY_WARNING && (
          <p className="dl-fine">
            This browser decrypts in memory and this file is large; on a phone it may run out. A desktop browser
            decrypts straight to disk.
          </p>
        )}

        {downloadsLeft !== null && !expired && !ready && (
          <p className="dl-fine">
            {downloadsLeft} download{downloadsLeft === 1 ? "" : "s"} left before it is deleted. A download counts once
            it has fully arrived.
          </p>
        )}

        <p className="dl-back">
          <a href="/">Share your own files with DocDrop</a>
        </p>
      </main>
    </>
  );
}
