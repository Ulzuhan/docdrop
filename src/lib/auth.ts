/**
 * DocDrop — dashboard authentication.
 *
 * Access model (designed for a service that may be exposed to the internet):
 *
 *   PUBLIC         /d/[id], /api/info/[id], /api/download/[id]
 *                  The 72-bit link id is the secret. Lets you share a file with
 *                  someone without handing out credentials.
 *
 *   AUTHENTICATED  /, /api/upload, /api/files, /api/cleanup
 *                  Uploading, listing everything and purging require the password.
 *
 * The session is a signed cookie (HMAC-SHA256) with no server-side state: changing
 * DOCDROP_SESSION_SECRET revokes everything.
 *
 * Authorisation is enforced by requireSession() inside each route, as Next's own
 * documentation recommends — never by a proxy/middleware check alone.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "docdrop_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Configuration ──────────────────────────────────────────────────
/**
 * DOCDROP_PASSWORD_HASH format: `scrypt$<salt_hex>$<hash_hex>`.
 * Generated with `npm run set-password`.
 */
function passwordHash(): string | null {
  return process.env.DOCDROP_PASSWORD_HASH?.trim() || null;
}

function sessionSecret(): string | null {
  return process.env.DOCDROP_SESSION_SECRET?.trim() || null;
}

/**
 * The password is OPTIONAL and acts as a switch:
 *
 *   without DOCDROP_PASSWORD_HASH  → open service (private network, or behind a
 *                                    temporary tunnel opened and closed by hand)
 *   with DOCDROP_PASSWORD_HASH     → uploading, listing and purging need the password
 *
 * To enable it: `npm run set-password`, paste the two lines into the environment
 * file and restart. No code changes needed.
 */
export function isConfigured(): boolean {
  return Boolean(passwordHash() && sessionSecret());
}

/** True if dashboard operations require a session. */
export function authRequired(): boolean {
  return isConfigured();
}

// ─── Password ───────────────────────────────────────────────────────
export function hashPassword(password: string, salt = randomBytes(16).toString("hex")): string {
  const derived = scryptSync(password.normalize("NFKC"), salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string): boolean {
  const stored = passwordHash();
  if (!stored) return false;

  const [scheme, salt, expected] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !expected) return false;

  let derived: Buffer;
  try {
    derived = scryptSync(password.normalize("NFKC"), salt, 64);
  } catch {
    return false;
  }

  const expectedBuf = Buffer.from(expected, "hex");
  // Constant-time comparison: a normal one leaks the password byte by byte
  // through the response time.
  if (derived.length !== expectedBuf.length) return false;
  return timingSafeEqual(derived, expectedBuf);
}

// ─── Cookie signing ─────────────────────────────────────────────────
function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createSessionToken(): string | null {
  const secret = sessionSecret();
  if (!secret) return null;
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + SESSION_TTL_MS })
  ).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken(token: string | undefined): boolean {
  const secret = sessionSecret();
  if (!secret || !token) return false;

  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;

  const payload = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = sign(payload, secret);

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof exp === "number" && exp > Date.now();
  } catch {
    return false;
  }
}

// ─── Used from routes and pages ─────────────────────────────────────
export async function hasSession(): Promise<boolean> {
  if (!authRequired()) return true;
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

/**
 * Returns null if the request may proceed, or the 401 response to send back.
 * With no password configured it always lets the request through.
 */
export async function requireSession(): Promise<Response | null> {
  if (!authRequired()) return null;
  if (await hasSession()) return null;
  return Response.json({ error: "Unauthorized" }, { status: 401 });
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
