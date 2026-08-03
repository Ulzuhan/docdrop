/**
 * DocDrop — capa única de acceso al almacén en disco.
 *
 * El disco es la ÚNICA fuente de verdad: no hay caché en memoria. Antes había dos
 * (una a nivel de módulo en /api/upload y otra en globalThis en /api/download) que se
 * desincronizaban entre sí y con el disco, así que el contador de descargas que veía
 * la lista no era el real.
 *
 * Layout: .docdrop-uploads/<id>/{file,meta.json}
 */
import { randomBytes } from "crypto";
import { existsSync } from "fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { join } from "path";

/**
 * Directorio de datos. Configurable porque en producción el servicio corre con un
 * usuario dedicado y guarda en /var/lib/docdrop, fuera del directorio del código.
 */
export const UPLOAD_DIR =
  process.env.DOCDROP_DATA_DIR?.trim() || join(process.cwd(), ".docdrop-uploads");

function envBytes(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export const MAX_FILE_SIZE = envBytes("DOCDROP_MAX_FILE_BYTES", 10 * 1024 * 1024 * 1024); // 10 GB
/** Tope de ocupación total: sin esto, subir hasta llenar el disco tumba la máquina. */
export const MAX_TOTAL_BYTES = envBytes("DOCDROP_MAX_TOTAL_BYTES", 20 * 1024 * 1024 * 1024); // 20 GB
export const MIN_TTL_HOURS = 1;
export const MAX_TTL_HOURS = 24 * 30; // 30 días
export const MAX_DOWNLOAD_LIMIT = 10_000;

export interface FileMeta {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  uploadedAt: number;
  expiresAt: number;
  downloadCount: number;
  maxDownloads: number; // 0 = ilimitado
  /**
   * Marca de "lápida": el contenido ya se borró, pero se conserva el meta.json un
   * tiempo para poder responder "esto caducó / agotó sus descargas" en vez de un
   * "no existe" indistinguible de un enlace mal copiado.
   */
  burnedAt?: number;
  burnedReason?: "expired" | "exhausted";
}

/** Cuánto se conservan las lápidas antes de desaparecer del todo. */
export const TOMBSTONE_TTL = 7 * 24 * 60 * 60 * 1000;

// ─── IDs y rutas ────────────────────────────────────────────────────
// Todo id llega desde la URL, así que se valida antes de tocarlo con join():
// sin esto, un id como "../../etc" escaparía de UPLOAD_DIR.
const ID_RE = /^[0-9a-f]{12,64}$/;

export function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

export function generateId(): string {
  return randomBytes(9).toString("hex"); // 18 chars, 72 bits
}

function entryDir(id: string): string {
  if (!isValidId(id)) throw new Error(`Invalid id: ${id}`);
  return join(UPLOAD_DIR, id);
}

export function blobPath(id: string): string {
  return join(entryDir(id), "file");
}

function metaPath(id: string): string {
  return join(entryDir(id), "meta.json");
}

// ─── Lectura / escritura ────────────────────────────────────────────
export async function readMeta(id: string): Promise<FileMeta | null> {
  if (!isValidId(id)) return null;
  try {
    return JSON.parse(await readFile(metaPath(id), "utf-8")) as FileMeta;
  } catch {
    return null;
  }
}

/** Escritura atómica: tmp + rename, para no dejar un meta.json a medias si el proceso muere. */
export async function writeMeta(meta: FileMeta): Promise<void> {
  const target = metaPath(meta.id);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(meta, null, 2));
  await rename(tmp, target);
}

export async function createEntryDir(id: string): Promise<void> {
  await mkdir(entryDir(id), { recursive: true });
}

export async function deleteEntry(id: string): Promise<void> {
  if (!isValidId(id)) return;
  await rm(entryDir(id), { recursive: true, force: true });
}

// ─── Estado ─────────────────────────────────────────────────────────
export function isExpired(meta: FileMeta, now = Date.now()): boolean {
  return meta.expiresAt < now;
}

export function isExhausted(meta: FileMeta): boolean {
  return meta.maxDownloads > 0 && meta.downloadCount >= meta.maxDownloads;
}

export function isBurned(meta: FileMeta): boolean {
  return meta.burnedAt !== undefined;
}

export function isAvailable(meta: FileMeta, now = Date.now()): boolean {
  return !isBurned(meta) && !isExpired(meta, now) && !isExhausted(meta);
}

/** Por qué un fichero ya no se puede descargar (null si sigue disponible). */
export function unavailableReason(
  meta: FileMeta,
  now = Date.now()
): "expired" | "exhausted" | null {
  if (meta.burnedReason) return meta.burnedReason;
  if (isExpired(meta, now)) return "expired";
  if (isExhausted(meta)) return "exhausted";
  return null;
}

/**
 * Borra el contenido pero deja el meta.json como lápida. Libera el espacio (que es lo
 * que importa) conservando el motivo para quien abra el enlace después.
 */
export async function burn(id: string, reason: "expired" | "exhausted"): Promise<void> {
  const meta = await readMeta(id);
  if (!meta) return;
  await rm(blobPath(id), { force: true });
  meta.burnedAt = Date.now();
  meta.burnedReason = reason;
  await writeMeta(meta);
}

/** Bytes ocupados ahora mismo por los ficheros vivos (no cuenta las lápidas). */
export async function usedBytes(): Promise<number> {
  if (!existsSync(UPLOAD_DIR)) return 0;
  let ids: string[];
  try {
    ids = await readdir(UPLOAD_DIR);
  } catch {
    return 0;
  }

  let total = 0;
  for (const id of ids) {
    if (!isValidId(id)) continue;
    try {
      total += (await stat(blobPath(id))).size;
    } catch {
      // Sin blob (lápida o subida a medias): no ocupa.
    }
  }
  return total;
}

export async function listMeta(): Promise<FileMeta[]> {
  if (!existsSync(UPLOAD_DIR)) return [];
  let ids: string[];
  try {
    ids = await readdir(UPLOAD_DIR);
  } catch {
    return [];
  }
  const metas: FileMeta[] = [];
  for (const id of ids) {
    const meta = await readMeta(id);
    if (meta) metas.push(meta);
  }
  return metas;
}

/**
 * ¿La entrada corresponde a una subida por trozos todavía retomable?
 *
 * Se lee session.json a mano en vez de usar el módulo de sesiones para no crear una
 * dependencia circular entre ambos.
 */
async function hasLiveSession(id: string, now: number): Promise<boolean> {
  try {
    const raw = await readFile(join(entryDir(id), "session.json"), "utf-8");
    const session = JSON.parse(raw) as { sessionExpiresAt?: number };
    return typeof session.sessionExpiresAt === "number" && session.sessionExpiresAt > now;
  } catch {
    return false;
  }
}

/** Borra lo caducado y lo agotado. Devuelve los ids eliminados. */
export async function cleanup(): Promise<string[]> {
  if (!existsSync(UPLOAD_DIR)) return [];
  const now = Date.now();
  const deleted: string[] = [];
  let ids: string[];
  try {
    ids = await readdir(UPLOAD_DIR);
  } catch {
    return [];
  }

  for (const id of ids) {
    if (!isValidId(id)) continue; // ignora restos ajenos al formato
    const meta = await readMeta(id);
    if (!meta) {
      // Sin meta.json puede ser una subida por trozos todavía en marcha: mientras su
      // sesión siga viva no se toca, o se borraría una subida de varios GB a medias.
      if (await hasLiveSession(id, now)) continue;

      // Directorio huérfano (subida interrumpida): se borra si ya no está caliente.
      try {
        const s = await stat(entryDir(id));
        if (now - s.mtimeMs > 60 * 60 * 1000) {
          await deleteEntry(id);
          deleted.push(id);
        }
      } catch {}
      continue;
    }

    if (isBurned(meta)) {
      // Lápida: se elimina del todo cuando ya nadie va a preguntar por ella.
      if (now - meta.burnedAt! > TOMBSTONE_TTL) {
        await deleteEntry(id);
        deleted.push(id);
      }
      continue;
    }

    const reason = unavailableReason(meta, now);
    if (reason) {
      await burn(id, reason);
      deleted.push(id);
    }
  }
  return deleted;
}

// ─── Reserva de descarga ────────────────────────────────────────────
// Serializa el leer-incrementar-escribir por id. Sin esto, dos descargas
// simultáneas leen el mismo downloadCount y el límite se supera.
// Vale para un solo proceso Node (el caso de este homelab); con varias
// instancias haría falta un lock en disco o una base de datos.
const chains = new Map<string, Promise<unknown>>();

function serialize<T>(id: string, task: () => Promise<T>): Promise<T> {
  const prev = chains.get(id) ?? Promise.resolve();
  const next = prev.then(task, task);
  chains.set(
    id,
    next.catch(() => {}).finally(() => {
      if (chains.get(id) === next) chains.delete(id);
    })
  );
  return next;
}

export type ClaimResult =
  | { ok: true; meta: FileMeta }
  | { ok: false; reason: "not_found" | "expired" | "exhausted" };

/**
 * Reserva una descarga: valida disponibilidad e incrementa el contador de forma
 * serializada. `count: false` solo comprueba (para peticiones Range de continuación,
 * que son parte de una descarga ya contabilizada).
 */
export function claimDownload(id: string, count = true): Promise<ClaimResult> {
  return serialize(id, async () => {
    const meta = await readMeta(id);
    if (!meta) return { ok: false, reason: "not_found" } as const;

    const reason = unavailableReason(meta);
    if (reason) {
      if (!isBurned(meta)) await burn(id, reason);
      return { ok: false, reason } as const;
    }

    if (!count) return { ok: true, meta } as const;

    meta.downloadCount++;
    await writeMeta(meta);

    // Si esta era la última descarga permitida el contenido ya no sirve para nada, pero
    // no se puede borrar aquí: todavía hay que enviarlo. Lo hace retireIfExhausted()
    // cuando el stream termina.
    return { ok: true, meta } as const;
  });
}

/** Quema la entrada si ya agotó sus descargas. Se llama cuando el envío ha terminado. */
export async function retireIfExhausted(id: string): Promise<void> {
  await serialize(id, async () => {
    const meta = await readMeta(id);
    if (meta && !isBurned(meta) && isExhausted(meta)) await burn(id, "exhausted");
  });
}

// ─── Validación de parámetros de subida ─────────────────────────────
export function clampTtlHours(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 24;
  return Math.min(Math.max(Math.floor(n), MIN_TTL_HOURS), MAX_TTL_HOURS);
}

export function clampMaxDownloads(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0; // 0 = ilimitado
  return Math.min(Math.floor(n), MAX_DOWNLOAD_LIMIT);
}

/** Nombre de fichero seguro: sin rutas, sin caracteres de control, longitud acotada. */
export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!clean || clean === "." || clean === "..") return "file";
  return clean.slice(0, 255);
}

/** Content-Disposition con soporte de nombres no ASCII (RFC 5987/6266). */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
