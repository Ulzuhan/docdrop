/**
 * Guest upload links.
 *
 * The dashboard password keeps uploading private, but the whole point of the
 * service is receiving big files FROM other people — and sharing the password
 * with everyone who ever needs to send something is how a password stops being
 * one. A guest link is a scoped alternative: the owner mints a token from the
 * dashboard, shares /guest/<token>, and whoever holds it can upload (and only
 * upload) until the link expires or is revoked.
 *
 * The 128-bit token in the URL is the whole credential — the same trust model as
 * the 72-bit download ids, with more margin because this one accepts writes.
 *
 * Storage: one JSON file per link under UPLOAD_DIR/guests/. "guests" does not
 * match the hex id format, so every store walker (listMeta, cleanup, usedBytes)
 * already skips the directory without knowing it exists.
 */
import { randomBytes } from "crypto";
import { existsSync } from "fs";
import { mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { UPLOAD_DIR, sanitizeUploader } from "@/lib/store";
import { currentUser, requireSession } from "@/lib/auth";

const GUESTS_DIR = join(UPLOAD_DIR, "guests");

/** Header the guest client sends on every upload request. */
export const GUEST_HEADER = "x-docdrop-guest";

/** How long a link may live. Short by design: these travel over chat apps. */
export const MIN_LINK_TTL_HOURS = 1;
export const MAX_LINK_TTL_HOURS = 7 * 24;

/**
 * Ceiling on the TTL of files uploaded through a guest link. The owner can keep
 * something for 30 days; a guest cannot fill the store with month-long files.
 */
export const MAX_GUEST_FILE_TTL_HOURS = 72;

export interface GuestLink {
  token: string;
  /** Informational: whom the link was made for. Shows up as the uploader default. */
  label?: string;
  createdAt: number;
  expiresAt: number;
  /** Informational counter, updated best-effort (see recordGuestUpload). */
  uploadCount: number;
  /**
   * Quién lo emitió (`user.id`). Es lo que hace que un fichero subido por el
   * enlace aparezca en el panel de quien lo repartió — y de nadie más — y que
   * nadie pueda listar ni revocar los enlaces de otro. Ausente en los emitidos
   * antes de este campo: esos no se enseñan a nadie y caducan solos.
   */
  createdBy?: string;
}

// 32 hex chars = 128 bits. Also the path-safety check before join(), like ID_RE
// in store.ts: a token arrives from a URL or header and must never escape
// GUESTS_DIR.
const TOKEN_RE = /^[0-9a-f]{32}$/;

function linkPath(token: string): string {
  if (!TOKEN_RE.test(token)) throw new Error("Invalid guest token");
  return join(GUESTS_DIR, `${token}.json`);
}

async function readLink(token: string): Promise<GuestLink | null> {
  if (!TOKEN_RE.test(token)) return null;
  try {
    return JSON.parse(await readFile(linkPath(token), "utf-8")) as GuestLink;
  } catch {
    return null;
  }
}

async function writeLink(link: GuestLink): Promise<void> {
  await mkdir(GUESTS_DIR, { recursive: true });
  await writeFile(linkPath(link.token), JSON.stringify(link, null, 2));
}

export function clampLinkTtlHours(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 24;
  return Math.min(Math.max(Math.floor(n), MIN_LINK_TTL_HOURS), MAX_LINK_TTL_HOURS);
}

export async function createGuestLink(input: {
  ttlHours?: unknown;
  label?: unknown;
  createdBy?: string;
}): Promise<GuestLink> {
  const now = Date.now();
  const link: GuestLink = {
    token: randomBytes(16).toString("hex"),
    label: sanitizeUploader(input.label),
    createdAt: now,
    expiresAt: now + clampLinkTtlHours(input.ttlHours) * 60 * 60 * 1000,
    uploadCount: 0,
    createdBy: input.createdBy,
  };
  await writeLink(link);
  return link;
}

/**
 * A quién pertenece lo que entre por este enlace: a quien lo emitió.
 *
 * Devuelve el `owner` que debe llevar el fichero (`user:<id>`), o undefined si
 * el enlace es de antes de que los enlaces tuvieran emisor — ese fichero no
 * será de nadie y no se enseñará a nadie, pero su enlace directo funciona.
 */
/** Lectura sin validez: la revocación necesita mirar un enlace aunque ya caducara. */
export async function readGuestLink(token: string): Promise<GuestLink | null> {
  return readLink(token);
}

export async function ownerForGuestToken(token: string): Promise<string | undefined> {
  const link = await readLink(token).catch(() => null);
  return link?.createdBy ? `user:${link.createdBy}` : undefined;
}

/**
 * The link if it is still usable, null otherwise. An expired link is deleted on
 * the way out, so the guests directory cleans itself up with use; the periodic
 * sweep (cleanupGuestLinks) catches the ones nobody ever asks about again.
 */
export async function validGuestLink(token: string): Promise<GuestLink | null> {
  const link = await readLink(token);
  if (!link) return null;
  if (link.expiresAt < Date.now()) {
    await rm(linkPath(token), { force: true });
    return null;
  }
  return link;
}

/** Active links, newest first. For the dashboard. */
export async function listGuestLinks(): Promise<GuestLink[]> {
  if (!existsSync(GUESTS_DIR)) return [];
  let names: string[];
  try {
    names = await readdir(GUESTS_DIR);
  } catch {
    return [];
  }

  const links: GuestLink[] = [];
  for (const name of names) {
    const token = name.replace(/\.json$/, "");
    const link = await validGuestLink(token);
    if (link) links.push(link);
  }
  return links.sort((a, b) => b.createdAt - a.createdAt);
}

export async function revokeGuestLink(token: string): Promise<boolean> {
  if (!TOKEN_RE.test(token)) return false;
  const existed = existsSync(linkPath(token));
  await rm(linkPath(token), { force: true });
  return existed;
}

/**
 * Bumps the link's upload counter. Best-effort read-modify-write: two uploads
 * starting at once may lose an increment, and that is fine — the counter is a
 * dashboard hint, not accounting. Serialising it is not worth a lock.
 */
export async function recordGuestUpload(token: string): Promise<void> {
  const link = await readLink(token);
  if (!link) return;
  link.uploadCount += 1;
  await writeLink(link).catch(() => {});
}

/** Removes expired links. Called from the same sweeps as the file cleanup. */
export async function cleanupGuestLinks(): Promise<number> {
  if (!existsSync(GUESTS_DIR)) return 0;
  let names: string[];
  try {
    names = await readdir(GUESTS_DIR);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const name of names) {
    const token = name.replace(/\.json$/, "");
    const link = await readLink(token);
    if (link && link.expiresAt < Date.now()) {
      await rm(linkPath(token), { force: true });
      removed += 1;
    }
  }
  return removed;
}

// ─── Used from the upload routes ────────────────────────────────────
/** The guest link authorising this request, if a valid token came with it. */
export async function guestFromRequest(request: Request): Promise<GuestLink | null> {
  const token = request.headers.get(GUEST_HEADER)?.trim().toLowerCase();
  if (!token) return null;
  return validGuestLink(token);
}

/**
 * Authorises an upload operation: the owner's session or a live guest token.
 * Same contract as requireSession() — null lets the request through, otherwise
 * the 401 to send back — so the routes swap one call for the other.
 */
export async function requireUploadAccess(request: Request): Promise<Response | null> {
  const unauthorized = await requireSession();
  if (!unauthorized) return null; // owner (or auth not configured)
  if (await guestFromRequest(request)) return null;
  return unauthorized;
}

/**
 * Con qué credencial viene esta petición: `user:<id>`, `guest:<token>`, o null.
 *
 * Existe porque tener acceso y ser el dueño de una subida concreta son dos cosas
 * distintas, y hasta ahora se trataban como una. `requireUploadAccess` dice si
 * quien llama puede subir *algo*; esto dice *quién es*, que es lo que hace falta
 * para no dejar que se meta en la subida de otro.
 *
 * Comprobado antes de arreglarlo, con dos enlaces de invitado distintos: el
 * segundo escribía el trozo 0 del fichero que estaba subiendo el primero, le leía
 * el nombre del documento y le cancelaba la subida. Dos personas de fuera con
 * enlaces distintos podían pisarse, y lo peor no es el estorbo: es que el fichero
 * que acaba llegando no sea el que mandó quien lo mandó.
 */
export async function credencialDe(request: Request): Promise<string | null> {
  const usuario = await currentUser();
  if (usuario) return `user:${usuario.id}`;
  const invitado = await guestFromRequest(request);
  if (invitado) return `guest:${invitado.token}`;
  return null;
}

/**
 * Si quien llama puede tocar esta subida en concreto.
 *
 * Una sesión sin dueño es de antes de que esto existiera: se deja pasar para no
 * romper las subidas en vuelo al desplegar. Duran 24 horas, así que pasado ese
 * plazo no queda ninguna.
 */
export function esDueno(owner: string | undefined, credencial: string | null): boolean {
  if (!owner) return true;
  return credencial !== null && owner === credencial;
}
