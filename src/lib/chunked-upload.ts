/**
 * Cliente de subida por trozos, con reanudación.
 *
 * El identificador de la subida se guarda en localStorage asociado a una huella del
 * fichero (nombre + tamaño + fecha de modificación). Si la subida se corta —pantalla
 * bloqueada, cambio de wifi a datos, pestaña cerrada— al volver a elegir el mismo
 * fichero se retoma donde iba en vez de empezar de cero.
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
  /** Bytes confirmados por el servidor. */
  loaded: number;
  total: number;
  /** True cuando se han reutilizado trozos de un intento anterior. */
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
    // Modo privado o almacenamiento lleno: se pierde la reanudación, nada más.
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
    /* ignorado */
  }
}

async function jsonOrThrow(res: Response, fallback: string): Promise<never | Record<string, unknown>> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || fallback);
  return data as Record<string, unknown>;
}

/**
 * SHA-256 del trozo, para que el servidor pueda detectar corrupción.
 *
 * Devuelve null si no se puede calcular: crypto.subtle solo existe en contextos
 * seguros (HTTPS o localhost), y por IP local en HTTP no está disponible. En ese
 * caso la subida sigue funcionando, solo que sin esta comprobación.
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

/** Envía un trozo con XMLHttpRequest para poder informar del progreso y cancelar. */
function putPart(
  uploadId: string,
  index: number,
  blob: Blob,
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
  checksum: string | null
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let lastLoaded = 0;

    xhr.upload.addEventListener("progress", (e) => {
      // Se informa del incremento, no del total, para poder sumar trozos en paralelo.
      onBytes(e.loaded - lastLoaded);
      lastLoaded = e.loaded;
    });

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else if (xhr.status === 401) {
        reject(new Error("UNAUTHORIZED"));
      } else {
        let message = `Fallo al enviar la parte ${index + 1} (${xhr.status})`;
        try {
          message = JSON.parse(xhr.responseText).error || message;
        } catch {
          /* respuesta no JSON */
        }
        // El progreso de este intento no cuenta: se descuenta lo ya sumado.
        onBytes(-lastLoaded);
        reject(new Error(message));
      }
    };
    xhr.onerror = () => {
      onBytes(-lastLoaded);
      reject(new Error("Error de red"));
    };
    xhr.onabort = () => reject(new Error("ABORTED"));

    signal.addEventListener("abort", () => xhr.abort(), { once: true });

    xhr.open("PUT", `/api/upload/${uploadId}/part/${index}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    if (checksum) xhr.setRequestHeader("X-Chunk-Sha256", checksum);
    xhr.send(blob);
  });
}

export interface UploadOptions {
  ttlHours: number;
  maxDownloads?: number;
  /** Etiqueta de quién sube, informativa. */
  uploadedBy?: string;
  onProgress?: (progress: Progress) => void;
  /** Trozos enviados a la vez. Más de uno aprovecha mejor el ancho de banda. */
  concurrency?: number;
  /** Reintentos por trozo antes de rendirse. */
  retries?: number;
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

    // ── Retomar si hay una subida previa del mismo fichero ──────────
    if (uploadId) {
      const res = await fetch(`/api/upload/${uploadId}`);
      if (res.ok) {
        const state = await res.json();
        chunkSize = state.chunkSize;
        totalParts = state.totalParts;
        received = state.received ?? [];
      } else {
        // Caducada o borrada en el servidor: se empieza de nuevo.
        forgetUpload(file);
        uploadId = null;
      }
    }

    // ── O abrir una nueva ───────────────────────────────────────────
    if (!uploadId) {
      const res = await fetch("/api/upload/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          size: file.size,
          mimeType: file.type || "application/octet-stream",
          ttlHours: options.ttlHours,
          maxDownloads: options.maxDownloads ?? 0,
          uploadedBy: options.uploadedBy,
        }),
      });
      if (res.status === 401) throw new Error("UNAUTHORIZED");
      const data = await jsonOrThrow(res, "No se pudo iniciar la subida");
      uploadId = data.uploadId as string;
      chunkSize = data.chunkSize as number;
      totalParts = data.totalParts as number;
      received = [];
      rememberUpload(file, uploadId);
    }

    const done = new Set<number>(received);
    const pending = Array.from({ length: totalParts }, (_, i) => i).filter((i) => !done.has(i));

    // Lo ya confirmado por el servidor cuenta como progreso desde el primer momento.
    let loaded = done.size > 0 ? Math.min(file.size, done.size * chunkSize) : 0;
    const report = (delta: number) => {
      loaded = Math.max(0, Math.min(file.size, loaded + delta));
      options.onProgress?.({ loaded, total: file.size, resumed: received.length > 0 });
    };
    report(0);

    // ── Enviar los trozos que falten ────────────────────────────────
    let cursor = 0;
    async function worker() {
      while (cursor < pending.length) {
        if (controller.signal.aborted) throw new Error("ABORTED");

        const index = pending[cursor++];
        const start = index * chunkSize;
        const blob = file.slice(start, Math.min(start + chunkSize, file.size));
        const checksum = await sha256Hex(blob);

        let attempt = 0;
        for (;;) {
          try {
            await putPart(uploadId!, index, blob, controller.signal, report, checksum);
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : "";
            if (message === "ABORTED" || message === "UNAUTHORIZED") throw error;
            if (++attempt > retries) throw error;
            // Espera creciente: si la red se ha caído, insistir de inmediato no ayuda.
            await new Promise((r) => setTimeout(r, 1000 * attempt));
          }
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, pending.length)) }, worker));

    // ── Cerrar ──────────────────────────────────────────────────────
    const res = await fetch(`/api/upload/${uploadId}/complete`, { method: "POST" });
    if (res.status === 401) throw new Error("UNAUTHORIZED");
    const result = (await jsonOrThrow(res, "No se pudo completar la subida")) as unknown as UploadResult;

    forgetUpload(file);
    return result;
  })();

  return {
    promise,
    abort: () => controller.abort(),
  };
}
