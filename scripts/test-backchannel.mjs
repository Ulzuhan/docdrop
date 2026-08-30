#!/usr/bin/env node
/**
 * El aviso de cierre de sesión del proveedor, probado como si fuera real.
 *
 * Levanta un proveedor de mentira que **firma de verdad**: genera un par RSA,
 * publica su JWKS y emite `logout_token` bien formados. Así se comprueba lo
 * único que importa de este endpoint — que echa a quien debe cuando el aviso
 * es legítimo, y que no se cree nada cuando no lo es.
 *
 * Los rechazos que se prueban no son teóricos: son los fallos clásicos de
 * quien implementa JWT a mano.
 *
 *   node scripts/test-backchannel.mjs   (con el servidor ya en marcha)
 *
 * Lo arranca `scripts/test-backchannel.sh`, que se ocupa del servidor y de
 * apuntarlo a este proveedor falso.
 */
import { createServer } from "node:http";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";

const BASE = process.env.BASE ?? "http://127.0.0.1:3996";
const PUERTO_IDP = Number(process.env.PUERTO_IDP ?? 9996);
const ORIGEN_IDP = `http://127.0.0.1:${PUERTO_IDP}`;
const EMISOR = `${ORIGEN_IDP}/application/o/docdrop`;
const CLIENT_ID = process.env.CLIENT_ID ?? "docdrop-pruebas";
const KID = "clave-de-pruebas";
/** Quien va a iniciar sesión de verdad para que haya algo que cerrar. */
const SUB_REAL = `sub-real-${randomUUID()}`;

let fallos = 0;
const check = (que, real, esperado) => {
  const ok = JSON.stringify(real) === JSON.stringify(esperado);
  if (!ok) fallos++;
  console.log(`  ${ok ? "✓" : "✗"} ${que}${ok ? "" : `  (esperaba ${JSON.stringify(esperado)}, dio ${JSON.stringify(real)})`}`);
};

// ── El proveedor de mentira ─────────────────────────────────────────
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };
// Una segunda clave, para probar que una firma con la clave equivocada no cuela.
const impostora = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;

const documento = {
  issuer: EMISOR,
  authorization_endpoint: `${EMISOR}/protocol/openid-connect/auth`,
  token_endpoint: `${EMISOR}/protocol/openid-connect/token`,
  userinfo_endpoint: `${EMISOR}/protocol/openid-connect/userinfo`,
  end_session_endpoint: `${EMISOR}/protocol/openid-connect/logout`,
  jwks_uri: `${EMISOR}/protocol/openid-connect/certs`,
};

const idp = createServer((req, res) => {
  if (req.url?.endsWith("/.well-known/openid-configuration")) {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(documento));
  } else if (req.url?.endsWith("/certs")) {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ keys: [jwk] }));
  } else if (req.url?.endsWith("/token")) {
    // Basta con un access_token: la aplicación lee la identidad de /userinfo.
    res.writeHead(200, { "Content-Type": "application/json" })
       .end(JSON.stringify({ access_token: "token-de-pruebas", token_type: "Bearer" }));
  } else if (req.url?.endsWith("/userinfo")) {
    res.writeHead(200, { "Content-Type": "application/json" })
       .end(JSON.stringify({ sub: SUB_REAL, email: `${SUB_REAL}@example.com`, name: "Persona de pruebas" }));
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((listo) => idp.listen(PUERTO_IDP, "127.0.0.1", listo));

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** Un logout_token como el que manda un proveedor de verdad. */
function firmar({ cabecera = {}, carga = {}, clave = privateKey } = {}) {
  const cab = { alg: "RS256", kid: KID, typ: "logout+jwt", ...cabecera };
  const ahora = Math.floor(Date.now() / 1000);
  const cuerpo = {
    iss: EMISOR,
    aud: CLIENT_ID,
    iat: ahora,
    exp: ahora + 3600,
    jti: randomUUID(),
    events: { "http://schemas.openid.net/event/backchannel-logout": {} },
    sub: process.env.SUB ?? "sub-de-pruebas",
    sid: randomUUID(),
    ...carga,
  };
  const firmado = `${b64(cab)}.${b64(cuerpo)}`;
  if (cabecera.alg === "none") return `${firmado}.`;
  return `${firmado}.${createSign("RSA-SHA256").update(firmado).sign(clave).toString("base64url")}`;
}

const avisar = (token) =>
  fetch(`${BASE}/api/auth/backchannel-logout`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ logout_token: token }),
  });

console.log("Avisos que NO se deben creer");
check("sin token, 400", (await avisar("")).status, 400);
check("un token que no es un JWT", (await avisar("esto-no-es-un-jwt")).status, 400);
check("firmado con OTRA clave", (await avisar(firmar({ clave: impostora }))).status, 400);
check("con alg=none, el fallo clásico", (await avisar(firmar({ cabecera: { alg: "none" } }))).status, 400);
check("con alg=HS256, el otro fallo clásico", (await avisar(firmar({ cabecera: { alg: "HS256" } }))).status, 400);
check("de otro emisor", (await avisar(firmar({ carga: { iss: "http://127.0.0.1:9998/otro" } }))).status, 400);
check("para otro destinatario", (await avisar(firmar({ carga: { aud: "otra-app" } }))).status, 400);
check("caducado", (await avisar(firmar({ carga: { exp: Math.floor(Date.now() / 1000) - 7200 } }))).status, 400);
check("sin el evento de cierre: es un id_token disfrazado",
  (await avisar(firmar({ carga: { events: {} } }))).status, 400);
check("con nonce, que la especificación prohíbe",
  (await avisar(firmar({ carga: { nonce: "n" } }))).status, 400);
check("sin sub ni sid, no dice a quién echar",
  (await avisar(firmar({ carga: { sub: undefined, sid: undefined } }))).status, 400);
// `iat` y `jti` son REQUERIDOS por la especificación (§2.4) y hasta el 30-08
// aquí no se exigían: `iat` sólo se miraba si venía, y `jti` ni se miraba.
check("sin iat, que la especificación exige",
  (await avisar(firmar({ carga: { iat: undefined } }))).status, 400);
check("sin jti, que la especificación exige",
  (await avisar(firmar({ carga: { jti: undefined } }))).status, 400);

// El cuerpo va acotado: este endpoint es público y no autenticado por
// definición —lo llama el proveedor—, y App Router no trae límite de tamaño.
const enorme = await fetch(`${BASE}/api/auth/backchannel-logout`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: `logout_token=${"A".repeat(64 * 1024)}`,
});
check("un cuerpo de 64 KiB se rechaza sin leerlo entero", enorme.status, 413);

console.log("\nEl aviso bueno");
const bueno = await avisar(firmar());
check("se atiende con 200", bueno.status, 200);
check("y no intenta poner ninguna cookie", bueno.headers.get("set-cookie"), null);

// Un `sub` que aquí no existe también es un aviso legítimo: no hay a quién
// echar, pero no hay nada que reintentar tampoco.
check("un sub desconocido se acepta igualmente",
  (await avisar(firmar({ carga: { sub: `nadie-${randomUUID()}` } }))).status, 200);

// Anti-replay: el MISMO token dos veces. El primero vale; el segundo no, aunque
// su firma siga siendo buena y no haya caducado. Sin esto, un aviso capturado
// se podía reenviar mañana para volver a echar a esa persona.
const repetido = firmar({ carga: { sub: `nadie-${randomUUID()}` } });
check("el mismo aviso, la primera vez", (await avisar(repetido)).status, 200);
check("y el mismo aviso repetido, ya no", (await avisar(repetido)).status, 400);

/* ══════════════════════════════════════════════════════════════════════
   Y lo único que de verdad importa: que una sesión VIVA se cierre.

   Todo lo de arriba comprueba que el endpoint no se cree lo que no debe.
   Esto comprueba que sirve para algo: se inicia sesión de verdad contra el
   proveedor de mentira, se confirma que la sesión funciona, llega el aviso, y
   deja de funcionar. Sin esto, un endpoint que respondiera 200 y no hiciera
   nada pasaría todas las demás pruebas.
   ══════════════════════════════════════════════════════════════════════ */
console.log("\nUna sesión de verdad, cerrada por el aviso");

const galleta = new Map();
const guardar = (res) => {
  for (const linea of res.headers.getSetCookie?.() ?? []) {
    const [par] = linea.split(";");
    const i = par.indexOf("=");
    if (i > 0) galleta.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
  }
};
const cabecera = () => [...galleta].map(([k, v]) => `${k}=${v}`).join("; ");

const ida = await fetch(`${BASE}/api/auth/login?next=%2F`, { redirect: "manual" });
guardar(ida);
const destino = new URL(ida.headers.get("location") ?? "");
check("la ida va al proveedor", destino.origin, ORIGEN_IDP);
const estado = destino.searchParams.get("state") ?? "";

const vuelta = await fetch(
  `${BASE}/api/auth/callback?code=codigo-de-pruebas&state=${encodeURIComponent(estado)}`,
  { redirect: "manual", headers: { cookie: cabecera() } }
);
guardar(vuelta);
// Un 3xx cualquiera: lo que importa es que vuelve a la aplicación con sesión,
// no con qué número exacto lo hace.
check("la vuelta abre sesión", vuelta.status >= 300 && vuelta.status < 400, true);

// DocDrop no tiene un "quién soy": lo que hay es el listado de ficheros, que
// exige sesión. Sirve igual y además comprueba algo que la gente usa.
const puede = async () => (await fetch(`${BASE}/api/files`, { headers: { cookie: cabecera() } })).status;

check("y la sesión sirve", await puede(), 200);

const cierre = await avisar(firmar({ carga: { sub: SUB_REAL } }));
check("el aviso se atiende", cierre.status, 200);

check("la sesión YA NO sirve: eso es la revocación llegando", await puede(), 401);

// Y lo que NO puede pasar: que revocar a uno eche a los demás.
const otroSub = `otro-${randomUUID()}`;
check("revocar a alguien no toca a los demás",
  (await avisar(firmar({ carga: { sub: otroSub } }))).status, 200);
check("y quien no fue revocado sigue fuera igualmente (ya lo estaba)", await puede(), 401);

console.log("\nY la petición mal formada");
const sinTipo = await fetch(`${BASE}/api/auth/backchannel-logout`, { method: "POST", body: "logout_token=x" });
check("sin content-type de formulario, 400", sinTipo.status, 400);

idp.close();
console.log(`\n${fallos === 0 ? "todo verde" : `${fallos} fallan`}`);
process.exit(fallos === 0 ? 0 : 1);
