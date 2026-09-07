#!/usr/bin/env node
/**
 * Compatibilidad de datos entre la versión de Node y la de Go.
 *
 * EL ORDEN IMPORTA Y ES POR TURNOS: Node publicado → Go → el MISMO Node, sobre
 * un solo almacén sintético. Nunca hay dos escritores a la vez, porque lo que
 * se prueba no es que aguanten una carrera sino que cada uno lee y respeta lo
 * que dejó el otro.
 *
 * Y NO SE CAMBIAN A LA VEZ el formato persistente y el runtime: el formato es
 * exactamente el de 2.3.1. Si alguna de estas comprobaciones falla, la vuelta
 * atrás no es segura y el despliegue no se hace.
 *
 * Lo lanza `test-compatibilidad.sh`, que levanta cada implementación por
 * separado sobre el mismo directorio y le pasa la fase.
 *
 *   sembrar-node        Node deja de todo: ficheros, sesión troceada, invitado,
 *                       cuenta, lápida y contadores a medias.
 *   comprobar-go        Go lee lo anterior sin tocar nada raro, termina lo que
 *                       estaba a medias y deja lo suyo.
 *   comprobar-node      Node vuelve y tiene que encontrarse todo en su sitio.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE;
const DATOS = process.env.DOCDROP_DATA_DIR;
const SECRETO = process.env.DOCDROP_SESSION_SECRET;
const ESTADO = process.env.ESTADO;
const fase = process.argv[2];

let pasan = 0, fallan = 0;
const check = (nombre, real, esperado) => {
  const ok = JSON.stringify(real) === JSON.stringify(esperado);
  console.log(`  ${ok ? "✓" : "✗"} ${nombre}${ok ? "" : `  (esperaba ${JSON.stringify(esperado)}, dio ${JSON.stringify(real)})`}`);
  if (ok) pasan++;
  else fallan++;
};
const nota = (n, v) => console.log(`  · ${n}: ${typeof v === "string" ? v : JSON.stringify(v)}`);

const leerEstado = () => (existsSync(ESTADO) ? JSON.parse(readFileSync(ESTADO, "utf8")) : {});
const guardarEstado = (v) => writeFileSync(ESTADO, JSON.stringify({ ...leerEstado(), ...v }, null, 2));

// ── Sembrar identidad como hacen las suites: la ficha en disco y la cookie
//    firmada con el mismo secreto. `requireSession` no se cree la cookie.
function crearUsuario(uid, sub = uid) {
  const dir = join(DATOS, "users");
  mkdirSync(dir, { recursive: true });
  const ahora = Date.now();
  writeFileSync(
    join(dir, `${createHash("sha256").update(sub).digest("hex")}.json`),
    JSON.stringify({ id: uid, oidcSub: sub, email: `${uid}@example.invalid`, name: uid, createdAt: ahora, lastSeenAt: ahora }, null, 2)
  );
}
const sesion = (uid) => {
  const carga = Buffer.from(JSON.stringify({ uid, iat: Date.now(), exp: Date.now() + 3600_000 })).toString("base64url");
  return `docdrop_session=${carga}.${createHmac("sha256", SECRETO).update(carga).digest("base64url")}`;
};

async function api(ruta, { cookie, metodo = "GET", cuerpo, tipo = "application/json", cabeceras = {} } = {}) {
  const res = await fetch(BASE + ruta, {
    method: metodo,
    headers: {
      ...(cuerpo !== undefined ? { "Content-Type": tipo } : {}),
      ...(cookie ? { cookie } : {}),
      ...cabeceras,
    },
    ...(cuerpo !== undefined ? { body: typeof cuerpo === "string" || Buffer.isBuffer(cuerpo) ? cuerpo : JSON.stringify(cuerpo) } : {}),
  });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body, cab: Object.fromEntries(res.headers) };
}

async function subir(datos, { cookie, nombre = "prueba.bin", extra = {} } = {}) {
  const res = await fetch(`${BASE}/api/upload`, {
    method: "POST",
    body: datos,
    headers: { "x-filename": encodeURIComponent(nombre), "content-type": "application/octet-stream", ...(cookie ? { cookie } : {}), ...extra },
  });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

const bajar = async (id, cabeceras = {}) => {
  const res = await fetch(`${BASE}/api/download/${id}`, { headers: cabeceras });
  const cuerpo = Buffer.from(await res.arrayBuffer());
  return { status: res.status, cuerpo, cab: Object.fromEntries(res.headers) };
};

const sha = (b) => createHash("sha256").update(b).digest("hex");
const metaEnDisco = (id) => JSON.parse(readFileSync(join(DATOS, id, "meta.json"), "utf8"));

// ════════════════════════════════════════════════════════════════════
if (fase === "sembrar-node") {
  console.log("\nNode 2.3.1 siembra el almacén");
  crearUsuario("ana");
  crearUsuario("bruno");
  const ana = sesion("ana");

  const contenidoLlano = randomBytes(20_000);
  const llano = await subir(contenidoLlano, { cookie: ana, nombre: "informe ñandú.pdf" });
  check("sube un fichero llano", llano.status, 200);

  // Uno con límite de una descarga, para gastarlo desde Go.
  const unaSola = await subir(randomBytes(1000), { cookie: ana, nombre: "una-sola.bin", extra: { "x-max-downloads": "1" } });
  check("sube uno con una sola descarga", unaSola.status, 200);

  // Uno marcado como cifrado: al servidor le da igual el contenido, pero la
  // marca tiene que sobrevivir al cambio de runtime.
  const cifrado = await subir(randomBytes(500), { cookie: ana, nombre: "encrypted", extra: { "x-docdrop-encrypted": "1" } });
  check("sube un bulto marcado como cifrado", cifrado.status, 200);

  // Uno que ya caducó: se fuerza en disco, para que Go se encuentre la lápida.
  const bytesCaduco = 300;
  const caduco = await subir(randomBytes(bytesCaduco), { cookie: ana, nombre: "caducado.bin" });
  const meta = metaEnDisco(caduco.body.id);
  meta.expiresAt = Date.now() - 60_000;
  writeFileSync(join(DATOS, caduco.body.id, "meta.json"), JSON.stringify(meta, null, 2));

  // Una subida troceada a medias: Go tiene que poder terminarla.
  const trozoBytes = Number(process.env.DOCDROP_CHUNK_BYTES);
  const partes = Buffer.concat([Buffer.alloc(trozoBytes, 0x41), Buffer.alloc(1234, 0x42)]);
  const iniciada = await api("/api/upload/init", { cookie: ana, metodo: "POST", cuerpo: { filename: "troceada.bin", size: partes.length, ttlHours: 24 } });
  check("abre una subida troceada", iniciada.status, 200);
  const subirTrozo = async (uploadId, indice, datos) =>
    (await fetch(`${BASE}/api/upload/${uploadId}/part/${indice}`, { method: "PUT", body: datos, headers: { cookie: ana } })).status;
  check("manda el primer trozo", await subirTrozo(iniciada.body.uploadId, 0, partes.subarray(0, trozoBytes)), 200);

  // Un enlace de invitado, y una subida hecha con él.
  const enlace = await api("/api/guest-links", { cookie: ana, metodo: "POST", cuerpo: { ttlHours: 24, label: "Compatibilidad" } });
  check("acuña un enlace de invitado", enlace.status, 201);
  const deInvitado = await subir(randomBytes(700), { nombre: "de-invitado.bin", extra: { "x-docdrop-guest": enlace.body.link.token } });
  check("y el invitado sube con él", deInvitado.status, 200);

  guardarEstado({
    llano: llano.body.id, shaLlano: sha(contenidoLlano),
    unaSola: unaSola.body.id, cifrado: cifrado.body.id, caduco: caduco.body.id,
    troceada: iniciada.body.uploadId, trozoBytes, restoTroceada: partes.subarray(trozoBytes).toString("base64"),
    shaTroceada: sha(partes),
    invitado: enlace.body.link.token, deInvitado: deInvitado.body.id, bytesCaduco,
    usados: (await api("/api/files", { cookie: ana })).body.storage.usedBytes,
  });
  nota("bytes ocupados según Node", leerEstado().usados);
}

// ════════════════════════════════════════════════════════════════════
if (fase === "comprobar-go") {
  const e = leerEstado();
  const ana = sesion("ana");
  console.log("\nGo lee lo que dejó Node");

  const lista = await api("/api/files", { cookie: ana });
  check("la sesión firmada por el turno anterior sigue valiendo", lista.status, 200);
  const ids = lista.body.files.map((f) => f.id);
  check("ve el fichero llano", ids.includes(e.llano), true);
  check("ve el que tiene una sola descarga", ids.includes(e.unaSola), true);
  check("ve el bulto cifrado", ids.includes(e.cifrado), true);
  check("ve lo subido por el invitado", ids.includes(e.deInvitado), true);
  check("y NO enseña el caducado", ids.includes(e.caduco), false);
  // No son los MISMOS bytes, y eso es lo correcto: al arrancar, Go barre igual
  // que barre Node, y el caducado que se sembró a mano pierde su contenido. Lo
  // que se comprueba es que libera exactamente ese fichero y ni un byte más.
  check("libera justo el espacio del caducado y nada más",
    lista.body.storage.usedBytes, e.usados - e.bytesCaduco);
  check("y el contenido del caducado ya no está en disco",
    existsSync(join(DATOS, e.caduco, "file")), false);
  check("conserva la marca de cifrado",
    lista.body.files.find((f) => f.id === e.cifrado)?.encrypted, true);
  check("y el nombre con acentos",
    lista.body.files.find((f) => f.id === e.llano)?.originalName, "informe ñandú.pdf");

  const bajada = await bajar(e.llano);
  check("el fichero se descarga entero", bajada.status, 200);
  check("y es byte a byte el que subió Node", sha(bajada.cuerpo), e.shaLlano);

  const caducado = await api(`/api/info/${e.caduco}`);
  check("la lápida sigue diciendo por qué", [caducado.status, caducado.body.reason], [410, "expired"]);

  // Gastar la única descarga: el contador tiene que quedar donde Node lo lea.
  const gasto = await bajar(e.unaSola);
  check("gasta la única descarga que quedaba", gasto.status, 200);
  const agotado = await api(`/api/info/${e.unaSola}`);
  check("y el enlace queda agotado", [agotado.status, agotado.body.reason], [410, "exhausted"]);

  // Terminar la subida troceada que Node dejó a medias.
  const estadoSubida = await api(`/api/upload/${e.troceada}`, { cookie: ana });
  check("ve la subida troceada a medias", [estadoSubida.status, estadoSubida.body.received], [200, [0]]);
  const resto = Buffer.from(e.restoTroceada, "base64");
  const puesto = await fetch(`${BASE}/api/upload/${e.troceada}/part/1`, { method: "PUT", body: resto, headers: { cookie: ana } });
  check("manda el trozo que faltaba", puesto.status, 200);
  const cerrada = await api(`/api/upload/${e.troceada}/complete`, { cookie: ana, metodo: "POST", cuerpo: {} });
  check("y la cierra", cerrada.status, 200);
  const troceada = await bajar(e.troceada);
  check("el fichero troceado sale entero y correcto", sha(troceada.cuerpo), e.shaTroceada);

  // El enlace de invitado de Node sigue sirviendo.
  const invitado = await api(`/api/guest/${e.invitado}`);
  check("el enlace de invitado sigue valiendo", [invitado.status, invitado.body.label], [200, "Compatibilidad"]);
  const subidaInvitado = await subir(randomBytes(400), { nombre: "go-invitado.bin", extra: { "x-docdrop-guest": e.invitado } });
  check("y todavía deja subir", subidaInvitado.status, 200);

  console.log("\nGo deja lo suyo para el turno de vuelta");
  const contenidoGo = randomBytes(15_000);
  const deGo = await subir(contenidoGo, { cookie: ana, nombre: "de-go.bin", extra: { "x-max-downloads": "2" } });
  check("sube un fichero", deGo.status, 200);
  const cifradoGo = await subir(randomBytes(600), { cookie: ana, nombre: "encrypted", extra: { "x-docdrop-encrypted": "1" } });
  check("y un bulto cifrado", cifradoGo.status, 200);

  // Y una troceada a medias en el otro sentido.
  const partesGo = Buffer.concat([Buffer.alloc(e.trozoBytes, 0x43), Buffer.alloc(999, 0x44)]);
  const iniciadaGo = await api("/api/upload/init", { cookie: ana, metodo: "POST", cuerpo: { filename: "troceada-go.bin", size: partesGo.length, ttlHours: 24 } });
  check("abre una subida troceada", iniciadaGo.status, 200);
  const primero = await fetch(`${BASE}/api/upload/${iniciadaGo.body.uploadId}/part/0`, { method: "PUT", body: partesGo.subarray(0, e.trozoBytes), headers: { cookie: ana } });
  check("y manda su primer trozo", primero.status, 200);

  const enlaceGo = await api("/api/guest-links", { cookie: ana, metodo: "POST", cuerpo: { ttlHours: 24, label: "Desde Go" } });
  check("acuña un enlace de invitado", enlaceGo.status, 201);

  guardarEstado({
    deGo: deGo.body.id, shaDeGo: sha(contenidoGo), cifradoGo: cifradoGo.body.id,
    troceadaGo: iniciadaGo.body.uploadId, restoTroceadaGo: partesGo.subarray(e.trozoBytes).toString("base64"),
    shaTroceadaGo: sha(partesGo), invitadoGo: enlaceGo.body.link.token,
    goInvitado: subidaInvitado.body.id,
    usadosGo: (await api("/api/files", { cookie: ana })).body.storage.usedBytes,
  });
}

// ════════════════════════════════════════════════════════════════════
if (fase === "comprobar-node") {
  const e = leerEstado();
  const ana = sesion("ana");
  console.log("\nNode 2.3.1 vuelve sobre los datos que escribió Go");

  const lista = await api("/api/files", { cookie: ana });
  check("la sesión sigue valiendo", lista.status, 200);
  const ids = lista.body.files.map((f) => f.id);
  check("ve lo que subió Go", ids.includes(e.deGo), true);
  check("ve el bulto cifrado de Go", ids.includes(e.cifradoGo), true);
  check("ve el fichero troceado que cerró Go", ids.includes(e.troceada), true);
  check("ve lo que subió el invitado desde Go", ids.includes(e.goInvitado), true);
  check("y sigue sin enseñar el caducado", ids.includes(e.caduco), false);
  check("cuenta los mismos bytes ocupados", lista.body.storage.usedBytes, e.usadosGo);

  const bajada = await bajar(e.deGo);
  check("descarga el fichero de Go entero", bajada.status, 200);
  check("y es byte a byte el que subió Go", sha(bajada.cuerpo), e.shaDeGo);

  // LO QUE NO PUEDE PASAR: que volver a Node resucite lo consumido.
  const agotado = await api(`/api/info/${e.unaSola}`);
  check("lo que Go agotó sigue agotado", [agotado.status, agotado.body.reason], [410, "exhausted"]);
  const gastado = await bajar(e.unaSola);
  check("y no se puede volver a descargar", gastado.status, 410);
  const caducado = await api(`/api/info/${e.caduco}`);
  check("y lo caducado sigue caducado", [caducado.status, caducado.body.reason], [410, "expired"]);

  // El contador que movió Go se lee igual: si faltara el campo, Node haría
  // `undefined++` y el límite dejaría de existir.
  const dosDescargas = lista.body.files.find((f) => f.id === e.deGo);
  check("el contador de descargas de Go es un número", typeof dosDescargas.downloadCount, "number");
  await bajar(e.deGo);
  const tercera = await bajar(e.deGo);
  check("el límite de dos descargas se respeta al volver", tercera.status, 410);

  // La troceada que dejó Go a medias se termina desde Node.
  const estadoSubida = await api(`/api/upload/${e.troceadaGo}`, { cookie: ana });
  check("ve la troceada que dejó Go", [estadoSubida.status, estadoSubida.body.received], [200, [0]]);
  const resto = Buffer.from(e.restoTroceadaGo, "base64");
  const puesto = await fetch(`${BASE}/api/upload/${e.troceadaGo}/part/1`, { method: "PUT", body: resto, headers: { cookie: ana } });
  check("manda el trozo que faltaba", puesto.status, 200);
  const cerrada = await api(`/api/upload/${e.troceadaGo}/complete`, { cookie: ana, metodo: "POST", cuerpo: {} });
  check("y la cierra", cerrada.status, 200);
  const troceada = await bajar(e.troceadaGo);
  check("el fichero sale entero y correcto", sha(troceada.cuerpo), e.shaTroceadaGo);

  // Los enlaces de invitado de los dos turnos.
  check("el enlace de invitado que acuñó Go vale",
    (await api(`/api/guest/${e.invitadoGo}`)).status, 200);
  check("y el que acuñó Node sigue valiendo",
    (await api(`/api/guest/${e.invitado}`)).status, 200);
  const enlaces = await api("/api/guest-links", { cookie: ana });
  check("los dos salen en el panel de quien los emitió",
    enlaces.body.links.filter((l) => [e.invitado, e.invitadoGo].includes(l.token)).length, 2);

  // Y el directorio no tiene nada que Node no sepa leer.
  const raros = readdirSync(DATOS).filter((n) => !/^[0-9a-f]{12,64}$/.test(n) && !["users", "guests", "revocaciones.json"].includes(n));
  check("Go no ha dejado ficheros que Node no conozca", raros, []);
}

console.log(`\n${pasan} pasan, ${fallan} fallan`);
process.exit(fallan === 0 ? 0 : 1);
