/**
 * Chunked uploads.
 *
 * WHY: a multi-GB upload in a single HTTP request runs into every limit along the
 * way — Cloudflare's proxy rejects bodies over 500 MiB (measured), and any network
 * hiccup forces starting over, which on a phone is the norm: the screen locks, wifi
 * switches to mobile data, the connection drops.
 *
 * HOW: the client splits the file and sends each chunk in its own request. Each
 * chunk is written straight into its position inside the final file (positional
 * write), so there is no assembly phase and no duplicated disk space. Which chunks
 * arrived is tracked with empty marker files, which are atomic and need no locking
 * between concurrent requests.
 *
 * Layout while an upload is in flight:
 *   <id>/file          final file, pre-allocated at its definitive size
 *   <id>/session.json  upload metadata
 *   <id>/parts/<n>     marker for "chunk n is already written"
 *
 * On completion <id>/meta.json appears and session.json and parts/ go away, so the
 * entry becomes a regular file for the rest of the application.
 */
import { ownerForGuestToken } from "@/lib/guest";
import { existsSync } from "fs";
import { mkdir, readdir, readFile, rm, stat, truncate, writeFile } from "fs/promises";
import { join } from "path";
import {
  UPLOAD_DIR,
  blobPath,
  clampMaxDownloads,
  clampTtlHours,
  generateId,
  isValidId,
  sanitizeFilename,
  sanitizeUploader,
  writeMeta,
  type FileMeta,
} from "@/lib/store";

/** Chunk size. Comfortably below Cloudflare's 500 MiB cap, and small enough that
 *  retrying one is cheap on a bad network. */
const configuredChunkSize = Number(process.env.DOCDROP_CHUNK_BYTES);
export const CHUNK_SIZE = Number.isSafeInteger(configuredChunkSize) && configuredChunkSize > 0
  ? Math.min(128 * 1024 * 1024, Math.max(1024 * 1024, configuredChunkSize))
  : 32 * 1024 * 1024;

/** How long a half-finished upload can be resumed. */
export const SESSION_TTL = 24 * 60 * 60 * 1000;

export interface UploadSession {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  ttlHours: number;
  maxDownloads: number;
  chunkSize: number;
  totalParts: number;
  createdAt: number;
  sessionExpiresAt: number;
  uploadedBy?: string;
  /**
   * Quién abrió esta subida: `user:<id>` o `guest:<token>`.
   *
   * `uploadedBy` no sirve para esto: es un nombre para mostrar, lo escribe quien
   * sube y puede repetirse o estar vacío. Esto es la credencial con la que se
   * empezó, y es lo que decide quién puede seguir tocándola.
   *
   * Opcional porque las sesiones abiertas antes de que esto existiera no lo
   * llevan. Duran 24 horas; pasadas ésas no queda ninguna sin dueño.
   */
  owner?: string;
}

function entryDir(id: string): string {
  if (!isValidId(id)) throw new Error(`Invalid id: ${id}`);
  return join(UPLOAD_DIR, id);
}

function sessionPath(id: string): string {
  return join(entryDir(id), "session.json");
}

function partsDir(id: string): string {
  return join(entryDir(id), "parts");
}

export async function readSession(id: string): Promise<UploadSession | null> {
  if (!isValidId(id)) return null;
  try {
    return JSON.parse(await readFile(sessionPath(id), "utf-8")) as UploadSession;
  } catch {
    return null;
  }
}

/** True if the entry is an upload in flight (rather than a finished file). */
export async function hasActiveSession(id: string): Promise<boolean> {
  const session = await readSession(id);
  return session !== null && session.sessionExpiresAt > Date.now();
}

export interface CreateSessionInput {
  filename: string;
  size: number;
  mimeType?: string;
  ttlHours?: unknown;
  maxDownloads?: unknown;
  uploadedBy?: unknown;
  owner?: string;
}

export async function createSession(input: CreateSessionInput): Promise<UploadSession> {
  const id = generateId();
  const now = Date.now();

  const session: UploadSession = {
    id,
    originalName: sanitizeFilename(input.filename),
    size: input.size,
    mimeType: input.mimeType || "application/octet-stream",
    ttlHours: clampTtlHours(input.ttlHours),
    maxDownloads: clampMaxDownloads(input.maxDownloads),
    chunkSize: CHUNK_SIZE,
    totalParts: Math.max(1, Math.ceil(input.size / CHUNK_SIZE)),
    createdAt: now,
    sessionExpiresAt: now + SESSION_TTL,
    uploadedBy: sanitizeUploader(input.uploadedBy),
    owner: input.owner,
  };

  await mkdir(partsDir(id), { recursive: true });
  // The file is pre-allocated at its final size so each chunk can be written at its
  // own offset. On a filesystem with sparse-file support this takes no disk space
  // until it is filled in.
  await writeFile(blobPath(id), "");
  await truncate(blobPath(id), session.size);
  await writeFile(sessionPath(id), JSON.stringify(session, null, 2));

  return session;
}

/** Indexes of the chunks received so far. */
export async function receivedParts(id: string): Promise<number[]> {
  try {
    const names = await readdir(partsDir(id));
    return names
      .map((name) => Number(name))
      .filter((n) => Number.isInteger(n) && n >= 0)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export async function markPartReceived(id: string, index: number): Promise<void> {
  await writeFile(join(partsDir(id), String(index)), "");
}

export async function isPartReceived(id: string, index: number): Promise<boolean> {
  return existsSync(join(partsDir(id), String(index)));
}

/** Byte range a chunk occupies inside the final file. */
export function partRange(session: UploadSession, index: number): { start: number; end: number } {
  const start = index * session.chunkSize;
  const end = Math.min(start + session.chunkSize, session.size);
  return { start, end };
}

export function partSize(session: UploadSession, index: number): number {
  const { start, end } = partRange(session, index);
  return end - start;
}

export type CompleteResult =
  | { ok: true; meta: FileMeta }
  | { ok: false; missing: number[] };

/**
 * Closes the upload: checks every chunk is there, writes meta.json and clears the
 * session leftovers. From then on the entry is a regular file.
 */
export async function completeSession(session: UploadSession): Promise<CompleteResult> {
  const received = new Set(await receivedParts(session.id));
  const missing: number[] = [];
  for (let i = 0; i < session.totalParts; i++) {
    if (!received.has(i)) missing.push(i);
  }
  if (missing.length > 0) return { ok: false, missing };

  const now = Date.now();
  const meta: FileMeta = {
    id: session.id,
    originalName: session.originalName,
    size: (await stat(blobPath(session.id))).size,
    mimeType: session.mimeType,
    uploadedAt: now,
    expiresAt: now + session.ttlHours * 60 * 60 * 1000,
    downloadCount: 0,
    maxDownloads: session.maxDownloads,
    uploadedBy: session.uploadedBy,
    // El dueño de la sesión, resuelto al terminar: `user:<id>` se queda tal
    // cual; `guest:<token>` pasa a ser de quien emitió el enlace. Una sesión
    // sin dueño (de antes de que lo llevaran) deja el fichero sin dueño: su
    // enlace funciona, el panel no lo enseña a nadie, la caducidad lo retira.
    owner: session.owner?.startsWith("guest:")
      ? await ownerForGuestToken(session.owner.slice("guest:".length))
      : session.owner,
  };

  await writeMeta(meta);
  // meta.json is already written: if cleanup fails now, the entry is still valid and
  // the session sweep will take care of the leftovers.
  await rm(partsDir(session.id), { recursive: true, force: true });
  await rm(sessionPath(session.id), { force: true });

  return { ok: true, meta };
}

export async function abortSession(id: string): Promise<void> {
  if (!isValidId(id)) return;
  await rm(entryDir(id), { recursive: true, force: true });
}

/** Removes half-finished uploads nobody is going to resume. */
export async function cleanupSessions(): Promise<string[]> {
  if (!existsSync(UPLOAD_DIR)) return [];
  const now = Date.now();
  const removed: string[] = [];

  let ids: string[];
  try {
    ids = await readdir(UPLOAD_DIR);
  } catch {
    return [];
  }

  for (const id of ids) {
    if (!isValidId(id)) continue;
    const session = await readSession(id);
    if (session && session.sessionExpiresAt < now) {
      await abortSession(id);
      removed.push(id);
    }
  }
  return removed;
}
