/**
 * Resumable chunked upload client.
 *
 * The upload id is kept in localStorage under a fingerprint of the file (name + size
 * + last modified). If the upload is interrupted — screen locked, wifi switched to
 * mobile data, tab closed — picking the same file again resumes where it left off
 * instead of starting over.
 */

export interface UploadResult {
  id: string;
  originalName: string;
  size: number;
  expiresAt: number;
  downloadUrl: string;
}

export interface UploadHandle {
  promise: Promise<UploadResult>;
  abort: () => void;
}

interface Progress {
  /** Bytes confirmed by the server. */
  loaded: number;
  total: number;
  /** True when chunks from a previous attempt were reused. */
  resumed: boolean;
}

const STORAGE_PREFIX = "docdrop:upload:";

function fingerprint(file: File): string {
  return `${STORAGE_PREFIX}${file.name}:${file.size}:${file.lastModified}`;
}

function rememberUpload(file: File, uploadId: string) {
  try {
    localStorage.setItem(fingerprint(file), uploadId);
  } catch {
    // Private mode or full storage: resuming is lost, nothing else.
  }
}

function recallUpload(file: File): string | null {
  try {
    return localStorage.getItem(fingerprint(file));
  } catch {
    return null;
  }
}

function forgetUpload(file: File) {
  try {
    localStorage.removeItem(fingerprint(file));
  } catch {
    /* ignored */
  }
}

async function jsonOrThrow(res: Response, fallback: string): Promise<never | Record<string, unknown>> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || fallback);
  return data as Record<string, unknown>;
}

/**
 * SHA-256 of the chunk, so the server can detect corruption.
 *
 * Returns null when it cannot be computed: crypto.subtle only exists in secure
 * contexts (HTTPS or localhost), so over plain HTTP on a local IP it is unavailable.
 * The upload still works in that case, just without this check.
 */
async function sha256Hex(blob: Blob): Promise<string | null> {
  try {
    if (!globalThis.crypto?.subtle) return null;
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

/** Sends one chunk over XMLHttpRequest, so progress can be reported and cancelled. */
function putPart(
  uploadId: string,
  index: number,
  blob: Blob,
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
  checksum: string | null,
  headers?: Record<string, string>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let lastLoaded = 0;

    xhr.upload.addEventListener("progress", (e) => {
      // Reports the delta, not the total, so parallel chunks can be summed.
      onBytes(e.loaded - lastLoaded);
      lastLoaded = e.loaded;
    });

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else if (xhr.status === 401) {
        reject(new Error("UNAUTHORIZED"));
      } else {
        let message = `Failed to send part ${index + 1} (${xhr.status})`;
        try {
          message = JSON.parse(xhr.responseText).error || message;
        } catch {
          /* non-JSON response */
        }
        // Progress from this attempt does not count: subtract what was added.
        onBytes(-lastLoaded);
        reject(new Error(message));
      }
    };
    xhr.onerror = () => {
      onBytes(-lastLoaded);
      reject(new Error("Network error"));
    };
    xhr.onabort = () => reject(new Error("ABORTED"));

    signal.addEventListener("abort", () => xhr.abort(), { once: true });

    xhr.open("PUT", `/api/upload/${uploadId}/part/${index}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    if (checksum) xhr.setRequestHeader("X-Chunk-Sha256", checksum);
    for (const [name, value] of Object.entries(headers ?? {})) {
      xhr.setRequestHeader(name, value);
    }
    xhr.send(blob);
  });
}

export interface UploadOptions {
  ttlHours: number;
  maxDownloads?: number;
  onProgress?: (progress: Progress) => void;
  /** Chunks sent at once. More than one uses the link better. */
  concurrency?: number;
  /** Retries per chunk before giving up. */
  retries?: number;
  /** Extra headers on every request — how a guest link authenticates. */
  headers?: Record<string, string>;
  /**
   * La fuente cifrada, cuando la subida va de punta a punta (e2ee-client.ts).
   * Sustituye a los BYTES del fichero — otro tamaño, otro contenido, nombre
   * neutro — pero no a su identidad: la huella de reanudación sigue siendo la
   * del fichero en claro, que es lo que la persona vuelve a elegir. Como los
   * nonces son deterministas, la fuente reconstruida produce bytes idénticos y
   * la reanudación no se entera de que hay cifrado.
   */
  fuente?: { size: number; rango(start: number, end: number): Promise<Uint8Array> };
  /** Lo que el servidor debe apuntar como nombre y tipo cuando hay fuente. */
  neutro?: { filename: string; mimeType: string };
}

export function uploadFileInChunks(file: File, options: UploadOptions): UploadHandle {
  const controller = new AbortController();
  const concurrency = options.concurrency ?? 2;
  const retries = options.retries ?? 3;

  const promise = (async (): Promise<UploadResult> => {
    let uploadId = recallUpload(file);
    let chunkSize = 0;
    let totalParts = 0;
    let received: number[] = [];

    // ── Resume if there is a previous upload of the same file ───────
    if (uploadId) {
      const res = await fetch(`/api/upload/${uploadId}`, { headers: options.headers });
      if (res.ok) {
        const state = await res.json();
        chunkSize = state.chunkSize;
        totalParts = state.totalParts;
        received = state.received ?? [];
      } else {
        // Expired or removed on the server: start over.
        forgetUpload(file);
        uploadId = null;
      }
    }

    // ── Or open a new one ───────────────────────────────────────────
    const fuente = options.fuente;
    const tamanoReal = fuente ? fuente.size : file.size;
    if (!uploadId) {
      const res = await fetch("/api/upload/init", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...options.headers },
        body: JSON.stringify({
          filename: fuente ? options.neutro?.filename ?? "encrypted" : file.name,
          size: tamanoReal,
          mimeType: fuente
            ? options.neutro?.mimeType ?? "application/octet-stream"
            : file.type || "application/octet-stream",
          ttlHours: options.ttlHours,
          maxDownloads: options.maxDownloads ?? 0,
          encrypted: Boolean(fuente),
        }),
      });
      if (res.status === 401) throw new Error("UNAUTHORIZED");
      const data = await jsonOrThrow(res, "Could not start the upload");
      uploadId = data.uploadId as string;
      chunkSize = data.chunkSize as number;
      totalParts = data.totalParts as number;
      received = [];
      rememberUpload(file, uploadId);
    }

    const done = new Set<number>(received);
    const pending = Array.from({ length: totalParts }, (_, i) => i).filter((i) => !done.has(i));

    // What the server already confirmed counts as progress from the start.
    let loaded = done.size > 0 ? Math.min(tamanoReal, done.size * chunkSize) : 0;
    const report = (delta: number) => {
      loaded = Math.max(0, Math.min(tamanoReal, loaded + delta));
      options.onProgress?.({ loaded, total: tamanoReal, resumed: received.length > 0 });
    };
    report(0);

    // ── Send the missing chunks ─────────────────────────────────────
    let cursor = 0;
    async function worker() {
      while (cursor < pending.length) {
        if (controller.signal.aborted) throw new Error("ABORTED");

        const index = pending[cursor++];
        const start = index * chunkSize;
        const fin = Math.min(start + chunkSize, tamanoReal);
        // Con fuente, los bytes se materializan al pedirlos: es lo que permite
        // cifrar un fichero de gigas sin tenerlo cifrado entero en ningún sitio.
        const blob = fuente
          ? new Blob([(await fuente.rango(start, fin)) as unknown as ArrayBuffer])
          : file.slice(start, fin);
        const checksum = await sha256Hex(blob);

        let attempt = 0;
        for (;;) {
          try {
            await putPart(uploadId!, index, blob, controller.signal, report, checksum, options.headers);
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : "";
            if (message === "ABORTED" || message === "UNAUTHORIZED") throw error;
            if (++attempt > retries) throw error;
            // Backoff: if the network is down, retrying immediately does not help.
            await new Promise((r) => setTimeout(r, 1000 * attempt));
          }
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, pending.length)) }, worker));

    // ── Finish ──────────────────────────────────────────────────────
    const res = await fetch(`/api/upload/${uploadId}/complete`, {
      method: "POST",
      headers: options.headers,
    });
    if (res.status === 401) throw new Error("UNAUTHORIZED");
    const result = (await jsonOrThrow(res, "Could not complete the upload")) as unknown as UploadResult;

    forgetUpload(file);
    return result;
  })();

  return {
    promise,
    abort: () => controller.abort(),
  };
}
