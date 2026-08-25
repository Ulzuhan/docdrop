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
import { requireSession } from "@/lib/auth";

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
}): Promise<GuestLink> {
  const now = Date.now();
  const link: GuestLink = {
    token: randomBytes(16).toString("hex"),
    label: sanitizeUploader(input.label),
    createdAt: now,
    expiresAt: now + clampLinkTtlHours(input.ttlHours) * 60 * 60 * 1000,
    uploadCount: 0,
  };
  await writeLink(link);
  return link;
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
