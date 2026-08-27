/**
 * Lo que comparten las suites.
 *
 * `requireSession` no se cree la cookie: saca el id y BUSCA la ficha del usuario
 * en disco, para que una cuenta borrada deje de funcionar en el acto. Así que una
 * suite que sólo firme una cookie recibe 401 en todo y parece que la aplicación
 * está cerrada, cuando lo que pasa es que no se ha probado nada. Por eso
 * `crearUsuario` escribe la ficha con el mismo formato que `lib/users.ts`.
 */
import { createHash, createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const BASE = process.env.BASE || "http://127.0.0.1:3995";
const SECRETO = process.env.DOCDROP_SESSION_SECRET || "secreto-de-pruebas-docdrop-32-bytes-minimo";
const DATOS = process.env.DOCDROP_DATA_DIR || ".docdrop-uploads";

let pasan = 0;
let fallan = 0;

export function check(nombre, real, esperado) {
  const ok = JSON.stringify(real) === JSON.stringify(esperado);
  console.log(
    `  ${ok ? "✓" : "✗"} ${nombre}${ok ? "" : `  (esperaba ${JSON.stringify(esperado)}, dio ${JSON.stringify(real)})`}`
  );
  if (ok) pasan++;
  else fallan++;
}

export function nota(nombre, valor) {
  console.log(`  · ${nombre}: ${typeof valor === "string" ? valor : JSON.stringify(valor)}`);
}

export function resumen() {
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  process.exit(fallan === 0 ? 0 : 1);
}

export async function crearUsuario(uid, sub = uid) {
  const dir = join(DATOS, "users");
  await mkdir(dir, { recursive: true });
  const ahora = Date.now();
  await writeFile(
    join(dir, `${createHash("sha256").update(sub).digest("hex")}.json`),
    JSON.stringify({ id: uid, oidcSub: sub, email: `${uid}@example.invalid`, name: uid, createdAt: ahora, lastSeenAt: ahora })
  );
}

export function sesion(uid, extra = {}) {
  const carga = Buffer.from(JSON.stringify({ uid, exp: Date.now() + 3600_000, ...extra })).toString("base64url");
  return `docdrop_session=${carga}.${createHmac("sha256", SECRETO).update(carga).digest("base64url")}`;
}

export function firmar(objeto, secreto = SECRETO) {
  const carga = Buffer.from(JSON.stringify(objeto)).toString("base64url");
  return `docdrop_session=${carga}.${createHmac("sha256", secreto).update(carga).digest("base64url")}`;
}

export const invitado = (token) => ({ "x-docdrop-guest": token });

export async function api(ruta, { cookie, metodo = "GET", cuerpo, tipo = "application/json", cabeceras = {} } = {}) {
  const res = await fetch(BASE + ruta, {
    method: metodo,
    headers: { ...(cuerpo !== undefined ? { "Content-Type": tipo } : {}), ...(cookie ? { cookie } : {}), ...cabeceras },
    ...(cuerpo !== undefined ? { body: typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo) } : {}),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body, cab: Object.fromEntries(res.headers) };
}

/** Sube un fichero de una tacada. El nombre va en cabecera; el cuerpo es el fichero. */
export async function subir(datos, { cookie, cabeceras = {}, nombre = "prueba.txt", extra = {} } = {}) {
  const res = await fetch(`${BASE}/api/upload`, {
    method: "POST",
    body: datos,
    headers: {
      "x-filename": nombre,
      "content-type": "text/plain",
      ...(cookie ? { cookie } : {}),
      ...cabeceras,
      ...extra,
    },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body };
}

export async function crearEnlace(cookie, campos = {}) {
  return api("/api/guest-links", { cookie, metodo: "POST", cuerpo: { label: "prueba", ...campos } });
}
