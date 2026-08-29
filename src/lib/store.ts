/**
 * DocDrop — single access layer to the on-disk store.
 *
 * Disk is the ONLY source of truth: there is no in-memory cache. There used to be
 * two (one module-scoped in /api/upload, another on globalThis in /api/download) and
 * they drifted apart from each other and from disk, so the download counter shown in
 * the listing was not the real one.
 *
 * Layout: .docdrop-uploads/<id>/{file,meta.json}
 */
import { randomBytes } from "crypto";
import { existsSync } from "fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { join } from "path";

/**
 * Data directory. Configurable because in production the service runs under a
 * dedicated user and stores files in /var/lib/docdrop, outside the code directory.
 */
// turbopackIgnore keeps the build tracer from following this path: it cannot resolve
// process.cwd() statically, assumes the whole project is needed and drags every file
// into the standalone output (201 MB instead of ~40 MB). The directory is created at
// runtime, so there is nothing to trace here anyway.
export const UPLOAD_DIR =
  process.env.DOCDROP_DATA_DIR?.trim() ||
  join(/* turbopackIgnore: true */ process.cwd(), ".docdrop-uploads");

function envBytes(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export const MAX_FILE_SIZE = envBytes("DOCDROP_MAX_FILE_BYTES", 10 * 1024 * 1024 * 1024); // 10 GB
/** Total storage cap: without it, uploading until the disk fills takes the machine down. */
export const MAX_TOTAL_BYTES = envBytes("DOCDROP_MAX_TOTAL_BYTES", 20 * 1024 * 1024 * 1024); // 20 GB
export const MIN_TTL_HOURS = 1;
export const MAX_TTL_HOURS = 24 * 30; // 30 days
export const MAX_DOWNLOAD_LIMIT = 10_000;

export interface FileMeta {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  uploadedAt: number;
  expiresAt: number;
  downloadCount: number;
  maxDownloads: number; // 0 = unlimited
  /** Who uploaded it. An informational label, not a verified identity. */
  uploadedBy?: string;
  /**
   * De quién es: `user:<id>`. La credencial de verdad, no la etiqueta de arriba.
   *
   * No existía, y su ausencia era el fallo de fondo de esta herramienta: nació
   * como carpeta compartida de un solo operador —la cuenta era la puerta, no el
   * inquilino— y al llegar las cuentas múltiples (2026-08-25) la puerta pasó a
   * ser de varios pero la habitación siguió siendo una. Cualquier cuenta veía,
   * descargaba y podía borrar los ficheros de todas las demás desde el panel.
   * Lo encontró el operador el primer día que hubo un segundo usuario real.
   *
   * Un fichero subido por un enlace de invitado pertenece a quien creó el
   * enlace. Uno sin dueño (anterior a este campo) no se enseña a nadie: su
   * enlace directo sigue funcionando y la caducidad lo retira sola.
   */
  owner?: string;
  /**
   * Tombstone marker: the content is already deleted, but the meta.json is kept for
   * a while so we can answer "this expired / ran out of downloads" instead of a
   * "not found" that is indistinguishable from a mistyped link.
   */
  burnedAt?: number;
  burnedReason?: "expired" | "exhausted";
}

/** How long tombstones are kept before disappearing for good. */
export const TOMBSTONE_TTL = 7 * 24 * 60 * 60 * 1000;

// ─── IDs and paths ──────────────────────────────────────────────────
// Every id arrives from the URL, so it is validated before being passed to join():
// without this, an id like "../../etc" would escape UPLOAD_DIR.
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

// ─── Read / write ───────────────────────────────────────────────────
export async function readMeta(id: string): Promise<FileMeta | null> {
  if (!isValidId(id)) return null;
  try {
    return JSON.parse(await readFile(metaPath(id), "utf-8")) as FileMeta;
  } catch {
    return null;
  }
}

/** Atomic write: tmp + rename, so a dying process never leaves a half-written meta.json. */
export async function writeMeta(meta: FileMeta): Promise<void> {
  const target = metaPath(meta.id);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(meta, null, 2));
  await rename(tmp, target);
}

export async function createEntryDir(id: string): Promise<void> {
  await mkdir(entryDir(id), { recursive: true });
  invalidateUsedBytes();
}

export async function deleteEntry(id: string): Promise<void> {
  if (!isValidId(id)) return;
  await rm(entryDir(id), { recursive: true, force: true });
  invalidateUsedBytes();
}

// ─── State ──────────────────────────────────────────────────────────
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

/** Why a file can no longer be downloaded (null if it is still available). */
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
 * Deletes the content but keeps the meta.json as a tombstone. Frees the space (which
 * is what matters) while preserving the reason for whoever opens the link later.
 */
export async function burn(id: string, reason: "expired" | "exhausted"): Promise<void> {
  const meta = await readMeta(id);
  if (!meta) return;
  await rm(blobPath(id), { force: true });
  invalidateUsedBytes();
  meta.burnedAt = Date.now();
  meta.burnedReason = reason;
  await writeMeta(meta);
}

/**
 * Bytes currently taken up by live files (tombstones don't count).
 *
 * The result is cached for a few seconds: the dashboard polls the listing every 10s
 * per open tab, and walking the whole directory on every request is wasted I/O. Any
 * change to the store invalidates the cache explicitly.
 */
let usedBytesCache: { value: number; at: number } | null = null;
const USED_BYTES_TTL = 5000;

export function invalidateUsedBytes(): void {
  usedBytesCache = null;
}

export async function usedBytes(): Promise<number> {
  const now = Date.now();
  if (usedBytesCache && now - usedBytesCache.at < USED_BYTES_TTL) {
    return usedBytesCache.value;
  }

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
      // No blob (tombstone or half-finished upload): takes no space.
    }
  }

  usedBytesCache = { value: total, at: now };
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
 * Is this entry a chunked upload that can still be resumed?
 *
 * session.json is read by hand instead of going through the upload-session module,
 * to avoid a circular dependency between the two.
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

/** Deletes what expired and what ran out of downloads. Returns the removed ids. */
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
    if (!isValidId(id)) continue; // ignore leftovers that don't match the format
    const meta = await readMeta(id);
    if (!meta) {
      // No meta.json may mean a chunked upload still in flight: while its session is
      // alive it is left alone, or a multi-GB upload would be deleted mid-way.
      if (await hasLiveSession(id, now)) continue;

      // Orphaned directory (interrupted upload): removed once it has gone cold.
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
      // Tombstone: dropped entirely once nobody is going to ask about it.
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

// ─── Download claim ─────────────────────────────────────────────────
// Serialises the read-increment-write per id. Without this, two simultaneous
// downloads read the same downloadCount and the limit gets exceeded.
// Good enough for a single Node process (the intended deployment); with several
// instances this would need a lock on disk or a database.
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
 * Claims a download: checks availability and increments the counter in a serialised
 * way. `count: false` only checks (for continuation Range requests, which are part
 * of a download that was already counted).
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

    // If this was the last allowed download the content is useless from now on, but
    // it can't be deleted here: it still has to be sent. retireIfExhausted() does it
    // once the stream finishes.
    return { ok: true, meta } as const;
  });
}

/** Burns the entry if it ran out of downloads. Called once the transfer is done. */
export async function retireIfExhausted(id: string): Promise<void> {
  await serialize(id, async () => {
    const meta = await readMeta(id);
    if (meta && !isBurned(meta) && isExhausted(meta)) await burn(id, "exhausted");
  });
}

// ─── Transfer continuations ─────────────────────────────────────────
/**
 * A resumed download must not be counted twice: an interrupted transfer picks up
 * with `Range: bytes=<n>-`, and charging for that would burn the quota of anyone on
 * a flaky connection.
 *
 * The test used to be "the range does not start at byte 0", but that is something
 * the client chooses freely: `Range: bytes=1-` returned everything but the first
 * byte, and `Range: bytes=-<size>` the WHOLE file, both uncounted and as many times
 * as asked. maxDownloads was decorative for anyone holding the link.
 *
 * Now only a client that already paid for a download gets free continuations. The
 * entry slides forward while the transfer is alive and expires an hour after the
 * last byte, so coming back much later counts as the new download it is.
 *
 * Caveat: this is keyed by client, and clientIp() collapses to "direct" when there
 * is no proxy in front (see ratelimit.ts). In that deployment continuations are
 * shared between clients — the same blind spot the rate limiter already has.
 */
const CONTINUATION_TTL = 60 * 60 * 1000;
const transfers = new Map<string, number>();
let lastTransferSweep = 0;

const transferKey = (id: string, client: string) => `${id}\0${client}`;

/** Records a counted transfer, so this client's continuations are recognised. */
export function registerTransfer(id: string, client: string): void {
  const now = Date.now();
  // Lazy sweep, so the Map does not grow with every one-off download.
  if (now - lastTransferSweep > CONTINUATION_TTL) {
    lastTransferSweep = now;
    for (const [key, at] of transfers) {
      if (now - at > CONTINUATION_TTL) transfers.delete(key);
    }
  }
  transfers.set(transferKey(id, client), now);
}

/** True if a Range request continues a transfer this client already paid for. */
export function isResumedTransfer(id: string, client: string): boolean {
  const at = transfers.get(transferKey(id, client));
  return at !== undefined && Date.now() - at < CONTINUATION_TTL;
}

// ─── Storage reservation ────────────────────────────────────────────
/**
 * Reserves room for a new entry and creates it under the same lock.
 *
 * The check and the creation used to be separate steps with a cached usage figure
 * in between, so several uploads starting at once each read the same stale total
 * and every one of them reserved the whole remaining quota: five 100 MB uploads
 * fitted into a 100 MB store, and even two a second apart did. Holding the lock
 * across both, and dropping the cache on the way in and out, is what turns the
 * quota into an actual limit.
 *
 * Returns null when there is not enough room. The lock key cannot collide with an
 * entry id: ids are hex.
 */
const QUOTA_LOCK = "quota";

/**
 * Bytes prometidos a subidas que todavía están llegando.
 *
 * Existe para no tener que sostener el candado durante toda la transferencia. Una
 * subida directa no ocupa sitio en disco hasta que termina, así que sin apuntarla
 * en algún lado dos que empiecen a la vez ven el mismo hueco libre y las dos
 * caben — que es la carrera que había—. Pero dejar el candado puesto mientras el
 * cuerpo va llegando serializa la aplicación entera: medido, una subida de 1 MB
 * tardaba 3,2 segundos porque esperaba a otra que goteaba, y con un fichero de
 * varios gigas desde una casa eso son minutos con todo el mundo parado.
 *
 * Así que se reserva bajo el candado, se transmite fuera, y se suelta al acabar.
 */
let reservados = 0;

/**
 * Aparta sitio para una subida que va a empezar.
 *
 * `pedir` recibe lo que queda libre de verdad —lo que hay en disco y lo que otras
 * subidas ya han prometido— y devuelve cuánto quiere apartar, o null si no cabe.
 * Lo que devuelve esta función hay que soltarlo siempre, pase lo que pase.
 */
export function reservarEspacio(
  pedir: (disponible: number) => number | null
): Promise<number | null> {
  return serialize(QUOTA_LOCK, async () => {
    invalidateUsedBytes();
    const disponible = Math.max(0, MAX_TOTAL_BYTES - (await usedBytes()) - reservados);
    const quiere = pedir(disponible);
    if (quiere === null || quiere <= 0) return null;
    reservados += quiere;
    return quiere;
  });
}

/** Devuelve lo apartado. Va siempre en un `finally`. */
export function soltarEspacio(bytes: number): void {
  reservados = Math.max(0, reservados - bytes);
  // Lo que llegó a escribirse ya está en disco: el siguiente tiene que verlo.
  invalidateUsedBytes();
}

export function withQuotaBudget<T>(
  create: (availableBytes: number) => Promise<T>
): Promise<T> {
  return serialize(QUOTA_LOCK, async () => {
    invalidateUsedBytes();
    // Descontando lo prometido a las subidas en vuelo, que aún no está en disco.
    const available = Math.max(0, MAX_TOTAL_BYTES - (await usedBytes()) - reservados);
    try {
      return await create(available);
    } finally {
      // Even a half-created entry occupies space: the next caller must see it.
      invalidateUsedBytes();
    }
  });
}

export function withQuota<T>(bytes: number, create: () => Promise<T>): Promise<T | null> {
  return withQuotaBudget((available) => bytes > available ? Promise.resolve(null) : create());
}

// ─── Upload parameter validation ────────────────────────────────────
export function clampTtlHours(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 24;
  return Math.min(Math.max(Math.floor(n), MIN_TTL_HOURS), MAX_TTL_HOURS);
}

export function clampMaxDownloads(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0; // 0 = unlimited
  return Math.min(Math.floor(n), MAX_DOWNLOAD_LIMIT);
}

/** Safe file name: no paths, no control characters, bounded length. */
export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!clean || clean === "." || clean === "..") return "file";
  return clean.slice(0, 255);
}

/**
 * Uploader name, so it's possible to tell whose file is whose in the listing.
 *
 * This is not an identity: the service may be running open and anyone can type
 * whatever they like. It is only cleaned up so it can't break the UI or sneak
 * anything odd into the metadata.
 */
export function sanitizeUploader(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
  return clean.length > 0 ? clean : undefined;
}

/** Content-Disposition with support for non-ASCII names (RFC 5987/6266). */
export function contentDisposition(filename: string, inline = false): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const kind = inline ? "inline" : "attachment";
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Can this type be served inside the browser without risk?
 *
 * Serving third-party uploads `inline` from the same origin is what turns a file
 * service into stored XSS: uploading an .html or an .svg with a <script> is enough.
 * Only media is allowed, and SVG is deliberately excluded because it is a document
 * that can run scripts.
 */
export function isInlineSafe(mimeType: string): boolean {
  const type = mimeType.split(";")[0].trim().toLowerCase();
  if (type === "image/svg+xml") return false;
  return (
    type.startsWith("video/") ||
    type.startsWith("audio/") ||
    (type.startsWith("image/") && type !== "image/svg+xml") ||
    type === "application/pdf"
  );
}
