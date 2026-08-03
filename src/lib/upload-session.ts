/**
 * Subida por trozos.
 *
 * POR QUÉ: una subida de varios GB en una sola petición HTTP choca con todos los
 * límites del camino — el proxy de Cloudflare rechaza cuerpos de más de 500 MiB
 * (medido), y cualquier corte de red obliga a empezar de cero, que en un móvil es
 * lo normal: se bloquea la pantalla, se cambia de wifi a datos, se cae la conexión.
 *
 * CÓMO: el cliente parte el fichero y envía cada trozo en su propia petición. Cada
 * trozo se escribe directamente en su posición dentro del fichero final (escritura
 * posicional), así que no hay fase de ensamblado ni se duplica el espacio en disco.
 * Qué trozos han llegado se registra con ficheros marca vacíos, que son atómicos y
 * no necesitan bloqueos entre peticiones concurrentes.
 *
 * Estructura mientras la subida está en curso:
 *   <id>/file          fichero final, reservado con su tamaño definitivo
 *   <id>/session.json  metadatos de la subida
 *   <id>/parts/<n>     marca de "el trozo n ya está escrito"
 *
 * Al completarse aparece <id>/meta.json y desaparecen session.json y parts/, con lo
 * que la entrada pasa a ser un fichero normal para el resto de la aplicación.
 */
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
  writeMeta,
  type FileMeta,
} from "@/lib/store";

/** Tamaño de trozo. Holgadamente por debajo del tope de 500 MiB de Cloudflare, y lo
 *  bastante pequeño para que reintentar uno cueste poco en una red mala. */
export const CHUNK_SIZE = Number(process.env.DOCDROP_CHUNK_BYTES) || 32 * 1024 * 1024;

/** Una subida a medias se puede retomar durante este tiempo. */
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

/** True si la entrada es una subida en curso (y no un fichero ya terminado). */
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
  };

  await mkdir(partsDir(id), { recursive: true });
  // Se reserva el fichero con su tamaño final para poder escribir cada trozo en su
  // posición. En un sistema de ficheros con soporte de huecos esto no ocupa disco
  // hasta que se rellena.
  await writeFile(blobPath(id), "");
  await truncate(blobPath(id), session.size);
  await writeFile(sessionPath(id), JSON.stringify(session, null, 2));

  return session;
}

/** Índices de los trozos ya recibidos. */
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

/** Rango de bytes que ocupa un trozo dentro del fichero final. */
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
 * Cierra la subida: comprueba que están todos los trozos, escribe meta.json y retira
 * los restos de la sesión. A partir de ese momento la entrada es un fichero normal.
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
  };

  await writeMeta(meta);
  // El meta.json ya está escrito: si algo falla al limpiar, la entrada sigue siendo
  // válida y el barrido de sesiones se encargará de los restos.
  await rm(partsDir(session.id), { recursive: true, force: true });
  await rm(sessionPath(session.id), { force: true });

  return { ok: true, meta };
}

export async function abortSession(id: string): Promise<void> {
  if (!isValidId(id)) return;
  await rm(entryDir(id), { recursive: true, force: true });
}

/** Elimina las subidas a medias que ya nadie va a retomar. */
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
