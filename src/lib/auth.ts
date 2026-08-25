/**
 * DocDrop — sessions, on top of identities that live in Authentik.
 *
 * Access model:
 *
 *   PUBLIC         /d/[id], /api/info/[id], /api/download/[id]
 *                  The 72-bit link id is the secret. Lets you share a file with
 *                  someone without handing out an account.
 *
 *   GUEST          /guest/[token] and uploading with that token
 *                  For people outside the group who need to send something in.
 *                  See lib/guest.ts.
 *
 *   SIGNED IN      /, /api/upload, /api/files, /api/cleanup
 *                  Uploading, listing everything and purging need an account.
 *
 * The shared password is gone: who may sign in is decided by Authentik, which
 * only issues tokens for people in this application's group. Asking for an
 * account and being let in happens there, once, for every service.
 *
 * The session is still a signed cookie (HMAC-SHA256) with no server-side
 * state, but it now names a user. Changing DOCDROP_SESSION_SECRET still
 * revokes every session at once; deleting somebody's account revokes theirs.
 *
 * Authorisation is enforced by requireSession() inside each route, as Next's
 * own documentation recommends — never by a proxy/middleware check alone.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { findById, upsertFromIdentity, type DocDropUser } from "@/lib/users";
import { oidcConfigured, type OidcIdentity } from "@/lib/oidc";

export const SESSION_COOKIE = "docdrop_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sessionSecret(): string | null {
  return process.env.DOCDROP_SESSION_SECRET?.trim() || null;
}

/**
 * Whether this instance can authenticate anybody at all. Without the OIDC
 * client or the signing secret there is no way in — and, unlike the old
 * password mode, no way to fall back to an open service either: an upload
 * endpoint reachable by anyone is free anonymous hosting.
 */
export function isConfigured(): boolean {
  return Boolean(sessionSecret() && oidcConfigured());
}

/** Kept for the callers that only want to know whether to show a log-out button. */
export function authRequired(): boolean {
  return true;
}

// ─── Cookie signing ─────────────────────────────────────────────────
function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createSessionToken(userId: string): string | null {
  const secret = sessionSecret();
  if (!secret) return null;
  const payload = Buffer.from(
    JSON.stringify({ uid: userId, exp: Date.now() + SESSION_TTL_MS })
  ).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** The user id inside a cookie, or null if it is forged, stale or malformed. */
export function userIdFromToken(token: string | undefined): string | null {
  const secret = sessionSecret();
  if (!secret || !token) return null;

  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = sign(payload, secret);

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof exp !== "number" || exp <= Date.now()) return null;
    return typeof uid === "string" ? uid : null;
  } catch {
    return null;
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  // Behind a tunnel everything is HTTPS; relaxed in local development (http) so
  // the login still works.
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: Math.floor(SESSION_TTL_MS / 1000),
};

// ─── Used from routes and pages ─────────────────────────────────────
/** The person behind this request, or null. */
export async function currentUser(): Promise<DocDropUser | null> {
  const store = await cookies();
  const userId = userIdFromToken(store.get(SESSION_COOKIE)?.value);
  if (!userId) return null;
  // Looked up rather than trusted from the cookie: an account that was removed
  // should not keep working until its cookie expires.
  return findById(userId);
}

export async function hasSession(): Promise<boolean> {
  return (await currentUser()) !== null;
}

/**
 * Returns null if the request may proceed, or the 401 response to send back.
 */
export async function requireSession(): Promise<Response | null> {
  if (await hasSession()) return null;
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

export async function startSession(identity: OidcIdentity): Promise<DocDropUser> {
  const user = await upsertFromIdentity(identity);
  const token = createSessionToken(user.id);
  if (!token) throw new Error("DOCDROP_SESSION_SECRET is not set");

  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions);
  return user;
}

export async function endSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
