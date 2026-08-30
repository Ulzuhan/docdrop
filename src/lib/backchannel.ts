/**
 * Back-channel logout: el proveedor avisa de que una sesión ha terminado.
 *
 * QUÉ RESUELVE. Hasta ahora, quitarle el acceso a alguien en el proveedor no
 * echaba a nadie de aquí: esta aplicación tiene su propia sesión y no vuelve a
 * preguntar. Lo único que la acotaba era su caducidad. Con esto, el proveedor
 * llama en cuanto la sesión muere allí y las de aquí se cierran al momento.
 *
 * Es el estándar (OIDC Back-Channel Logout 1.0), no un invento nuestro, y por
 * eso vale con cualquier proveedor que lo hable — Keycloak lo trae igual.
 *
 * LO QUE ESTO **NO** GARANTIZA, y conviene tenerlo escrito: el proveedor solo
 * avisa a las aplicaciones con un token de acceso todavía vivo para esa
 * sesión. Los nuestros duran una hora y no se refrescan, así que pasada esa
 * hora el aviso ya no llega. Es el carril rápido del caso normal —echar a
 * alguien que está usando la herramienta—, no la garantía. La garantía es que
 * la sesión de aquí caduca sola (ver `SESSION_TTL_HOURS` en auth.ts).
 *
 * Aquí la sesión no vive en el servidor, así que lo que hace el aviso no es
 * borrarla sino apuntar a su dueño en la lista de revocación
 * (lib/revocaciones.ts). El efecto que se ve desde fuera es el mismo que en
 * las herramientas con sesión en base de datos, que es lo que importa.
 *
 * Verificación, en el orden en que importa:
 *   1. firma contra el JWKS que anuncia el proveedor
 *   2. emisor y destinatario, que sean los nuestros
 *   3. que sea un token de CIERRE DE SESIÓN y no un id_token reciclado
 *   4. que no venga caducado ni del futuro
 *
 * Sin librerías: un JWT RS256 es una firma que `crypto` sabe comprobar, y la
 * clave llega en JWK, que `createPublicKey` acepta de fábrica.
 */
import { createPublicKey, createVerify } from "crypto";
import { discover, oidcConfig, type OidcConfig } from "./oidc";

const EVENTO_CIERRE = "http://schemas.openid.net/event/backchannel-logout";
/** Margen para relojes que no van exactamente iguales. */
const MARGEN_S = 120;

/**
 * Anti-replay de avisos de cierre de sesión.
 *
 * La caché vive en la memoria del proceso, y aquí eso basta: hay un solo
 * contenedor por servicio y estos avisos duran segundos, no días. Si algún día
 * hubiera dos réplicas habría que llevarla a un sitio común; lo peor que pasa
 * mientras tanto es aceptar el reenvío de un aviso que ya cerró esa sesión.
 */
const REPLAY_TTL_MS = 10 * 60 * 1000;
const jtiVistos = new Map<string, number>();

function yaVisto(jti: string): boolean {
  const ahora = Date.now();
  // Limpieza perezosa: sin esto el mapa crece mientras viva el proceso.
  for (const [k, caduca] of jtiVistos) if (caduca <= ahora) jtiVistos.delete(k);
  if (jtiVistos.has(jti)) return true;
  jtiVistos.set(jti, ahora + REPLAY_TTL_MS);
  return false;
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
}

let jwksCache: { url: string; at: number; claves: Jwk[] } | null = null;
const JWKS_TTL_MS = 10 * 60 * 1000;

async function claves(url: string, timeoutMs: number): Promise<Jwk[]> {
  if (jwksCache && jwksCache.url === url && Date.now() - jwksCache.at < JWKS_TTL_MS) {
    return jwksCache.claves;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`jwks: ${res.status}`);
  const doc = (await res.json()) as { keys?: Jwk[] };
  const lista = Array.isArray(doc.keys) ? doc.keys : [];
  jwksCache = { url, at: Date.now(), claves: lista };
  return lista;
}

/** Solo para las pruebas. */
export function forgetJwks(): void {
  jwksCache = null;
}

function trozos(jwt: string): { cabecera: Record<string, unknown>; carga: Record<string, unknown>; firmado: string; firma: Buffer } | null {
  const partes = jwt.split(".");
  if (partes.length !== 3) return null;
  try {
    const cabecera = JSON.parse(Buffer.from(partes[0], "base64url").toString());
    const carga = JSON.parse(Buffer.from(partes[1], "base64url").toString());
    return {
      cabecera,
      carga,
      firmado: `${partes[0]}.${partes[1]}`,
      firma: Buffer.from(partes[2], "base64url"),
    };
  } catch {
    return null;
  }
}

export interface CierreVerificado {
  sub?: string;
  sid?: string;
}

/**
 * Devuelve a quién hay que echar, o null si el token no es de fiar.
 *
 * Nunca lanza por un token malo: quien llama responde 400 y ya. Lanzar solo
 * es para lo que sí es un fallo nuestro (no poder hablar con el proveedor).
 */
export async function verificarCierre(
  jwt: string,
  cfg: OidcConfig = oidcConfig()!
): Promise<CierreVerificado | null> {
  const partido = trozos(jwt);
  if (!partido) return null;
  const { cabecera, carga, firmado, firma } = partido;

  // Solo RS256. Aceptar `alg` del propio token sin acotarlo es el fallo
  // clásico de los JWT: con `none` la firma sobra, y con HS256 la clave
  // pública pasa a ser el secreto.
  if (cabecera.alg !== "RS256") return null;
  if (cabecera.typ !== undefined && cabecera.typ !== "logout+jwt" && cabecera.typ !== "JWT") return null;

  const endpoints = await discover(cfg);
  if (!endpoints.jwks) throw new Error("el proveedor no anuncia jwks_uri");

  const lista = await claves(endpoints.jwks, 10_000);
  const kid = typeof cabecera.kid === "string" ? cabecera.kid : undefined;
  // Con `kid` se busca esa; sin él se prueban todas, que es lo que dice la
  // especificación y evita romperse en una rotación de claves.
  const candidatas = kid ? lista.filter((k) => k.kid === kid) : lista;
  const firmaValida = candidatas.some((jwk) => {
    try {
      const key = createPublicKey({ key: jwk as never, format: "jwk" });
      return createVerify("RSA-SHA256").update(firmado).verify(key, firma);
    } catch {
      return false;
    }
  });
  if (!firmaValida) return null;

  // Emisor: se aceptan el público y el interno, porque el proveedor firma con
  // la dirección por la que se le pidió el token (ver oidc.ts).
  const iss = typeof carga.iss === "string" ? carga.iss.replace(/\/+$/, "") : "";
  if (!endpoints.issuers.some((valido) => valido.replace(/\/+$/, "") === iss)) return null;

  const aud = carga.aud;
  const destinatarios = Array.isArray(aud) ? aud : [aud];
  if (!destinatarios.includes(cfg.clientId)) return null;

  const ahora = Math.floor(Date.now() / 1000);
  if (typeof carga.exp === "number" && carga.exp + MARGEN_S < ahora) return null;

  // `iat` y `jti` son REQUERIDOS en un Logout Token (OIDC Back-Channel Logout
  // 1.0 §2.4). Hasta el 30-08 aquí se miraba `iat` sólo SI venía, y `jti` no se
  // miraba en absoluto: un aviso capturado se podía reenviar mañana y volvería
  // a cerrar la sesión de esa persona. No es una escalada —cerrar la sesión de
  // otro no es entrar en ella—, pero cerrarlo sale gratis.
  //
  // Antes de exigirlos se comprobó que el proveedor los manda de verdad
  // (`create_logout_token` de Authentik pone iss, aud, iat, exp, jti y events).
  // Exigir un claim que el proveedor no envía es apagar el cierre de sesión sin
  // que nadie se entere, que es el fallo que esto pretende evitar.
  if (typeof carga.iat !== "number") return null;
  if (carga.iat - MARGEN_S > ahora) return null;
  const jti = typeof carga.jti === "string" ? carga.jti.trim() : "";
  if (!jti) return null;

  // Que sea de verdad un aviso de cierre y no otro token del mismo emisor
  // reenviado aquí.
  const eventos = carga.events;
  if (typeof eventos !== "object" || eventos === null) return null;
  if (!Object.prototype.hasOwnProperty.call(eventos, EVENTO_CIERRE)) return null;

  // La especificación lo prohíbe explícitamente: un `nonce` delata un
  // id_token disfrazado de aviso de cierre.
  if (carga.nonce !== undefined) return null;

  const sub = typeof carga.sub === "string" ? carga.sub : undefined;
  const sid = typeof carga.sid === "string" ? carga.sid : undefined;
  if (!sub && !sid) return null;

  // El anti-replay va EL ÚLTIMO a propósito: sólo se apunta un `jti` que ya ha
  // pasado todas las comprobaciones. Si se apuntara antes, cualquiera podría
  // envenenar la caché con tokens inválidos y bloquear el cierre de sesión de
  // verdad cuando llegara.
  if (yaVisto(jti)) return null;

  return { sub, sid };
}
