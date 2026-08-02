/**
 * DocDrop — autenticación del panel.
 *
 * Modelo de acceso (pensado para estar expuesto a internet vía Tailscale Funnel):
 *
 *   PÚBLICO      /d/[id], /api/info/[id], /api/download/[id]
 *                El secreto es el id de 72 bits del enlace. Permite compartir un
 *                fichero con alguien sin darle credenciales.
 *
 *   AUTENTICADO  /, /api/upload, /api/files, /api/cleanup
 *                Subir, ver la lista completa y purgar exige contraseña.
 *
 * La sesión es una cookie firmada (HMAC-SHA256), sin estado en servidor: para
 * revocarlo todo basta con cambiar DOCDROP_SESSION_SECRET.
 *
 * IMPORTANTE: el proxy hace solo una comprobación optimista (¿hay cookie?). La
 * autorización de verdad la hace requireSession() en cada ruta, tal y como
 * recomienda la documentación de Next.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "docdrop_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Configuración ──────────────────────────────────────────────────
/**
 * Formato de DOCDROP_PASSWORD_HASH: `scrypt$<salt_hex>$<hash_hex>`.
 * Se genera con `npm run set-password`.
 */
function passwordHash(): string | null {
  return process.env.DOCDROP_PASSWORD_HASH?.trim() || null;
}

function sessionSecret(): string | null {
  return process.env.DOCDROP_SESSION_SECRET?.trim() || null;
}

/**
 * Si falta configuración, la app queda cerrada en vez de abierta: sin contraseña
 * configurada no se puede entrar al panel (en vez de dejarlo sin protección).
 */
export function isConfigured(): boolean {
  return Boolean(passwordHash() && sessionSecret());
}

// ─── Contraseña ─────────────────────────────────────────────────────
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
  // Comparación en tiempo constante: una comparación normal filtra la contraseña
  // byte a byte a través del tiempo de respuesta.
  if (derived.length !== expectedBuf.length) return false;
  return timingSafeEqual(derived, expectedBuf);
}

// ─── Firma de la cookie ─────────────────────────────────────────────
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

// ─── Uso desde rutas y páginas ──────────────────────────────────────
export async function hasSession(): Promise<boolean> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

/** Devuelve null si hay sesión válida, o la respuesta 401 que debe devolverse. */
export async function requireSession(): Promise<Response | null> {
  if (await hasSession()) return null;
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

export const sessionCookieOptions = {
  httpOnly: true,
  // Con Funnel siempre se sirve por HTTPS; en desarrollo local (http) se relaja
  // para no romper el login.
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: Math.floor(SESSION_TTL_MS / 1000),
};
