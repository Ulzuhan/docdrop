/**
 * Quién puede qué.
 *
 * Esta aplicación tiene tres clases de visitante y conviene tenerlas claras
 * porque no son la misma puerta:
 *
 *   con cuenta   ve la lista entera y borra cualquier cosa. Es a propósito: es un
 *                buzón compartido de casa, y las altas las aprueba una persona.
 *   invitado     sólo sube, con un enlace que alguien con cuenta le ha dado. Ni
 *                lista, ni borra, ni crea más enlaces.
 *   cualquiera   descarga un fichero si tiene su enlace. El identificador ES el
 *                secreto, igual que en un enlace de "compartir".
 *
 * Y una cuarta cosa, que es la que faltaba: tener acceso para subir no es lo
 * mismo que ser el dueño de una subida concreta.
 */
import { api, check, crearEnlace, crearUsuario, firmar, invitado, nota, resumen, sesion, subir, BASE } from "./comun.mjs";

await crearUsuario("usuario-a");
await crearUsuario("usuario-b");
const a = sesion("usuario-a");
const b = sesion("usuario-b");

console.log("La puerta, por sus dos caras");
// Si la sesión legítima no entra, todos los 401 de abajo son de "esto no
// funciona", no de "esto está cerrado". Va primero por eso.
check("una sesión legítima lista ficheros", (await api("/api/files", { cookie: a })).status, 200);
check("sin cookie, no", (await api("/api/files")).status, 401);
check("ni crea enlaces de invitado", (await api("/api/guest-links", { metodo: "POST", cuerpo: {} })).status, 401);
check("ni lanza la limpieza", (await api("/api/cleanup", { metodo: "POST" })).status, 401);
check("ni inicia una subida", (await api("/api/upload/init", { metodo: "POST", cuerpo: { filename: "x", size: 1 } })).status, 401);

console.log("\nSesiones que no valen");
const [carga, firma] = a.split("=")[1].split(".");
const con = (v) => `docdrop_session=${v}`;
const ahora = Date.now();
for (const [que, cookie] of [
  ["la firma cambiada", con(`${carga}.${firma.slice(0, -4)}AAAA`)],
  ["la firma vacía", con(`${carga}.`)],
  ["sin firma ni punto", con(carga)],
  [
    "la carga cambiada dejando la firma buena",
    con(`${Buffer.from(JSON.stringify({ uid: "usuario-b", exp: ahora + 3600_000 })).toString("base64url")}.${firma}`),
  ],
  ["firmada con otro secreto", firmar({ uid: "usuario-a", exp: ahora + 3600_000 }, "otro-secreto")],
  ["caducada", firmar({ uid: "usuario-a", exp: ahora - 1000 })],
  ["sin caducidad", firmar({ uid: "usuario-a" })],
  ["de una cuenta que no existe", firmar({ uid: "nadie-de-nada", exp: ahora + 3600_000 })],
  ["basura", con("nada.de-nada")],
  ["vacía", con("")],
]) {
  check(`no entra con ${que}`, (await api("/api/files", { cookie })).status, 401);
}

console.log("\nHasta dónde llega un invitado");
const enlace = await crearEnlace(a);
const token = enlace.body?.link?.token;
check("una cuenta puede crear el enlace", enlace.status, 201);
check("y el token es largo", (token ?? "").length >= 24, true);

check(
  "el invitado sí puede subir",
  (await api("/api/upload/init", { cabeceras: invitado(token), metodo: "POST", cuerpo: { filename: "de-fuera.txt", size: 100 } })).status,
  200
);
check("pero no lista", (await api("/api/files", { cabeceras: invitado(token) })).status, 401);
check("ni crea más enlaces", (await api("/api/guest-links", { cabeceras: invitado(token), metodo: "POST", cuerpo: {} })).status, 401);
check("ni lanza la limpieza", (await api("/api/cleanup", { cabeceras: invitado(token), metodo: "POST" })).status, 401);
check(
  "y un token inventado no vale",
  (await api("/api/upload/init", { cabeceras: invitado("a".repeat(32)), metodo: "POST", cuerpo: { filename: "x", size: 1 } })).status,
  401
);

const revocado = await api(`/api/guest-links/${token}`, { cookie: a, metodo: "DELETE" });
check("una cuenta revoca el enlace", revocado.status, 200);
check(
  "y revocado deja de servir",
  (await api("/api/upload/init", { cabeceras: invitado(token), metodo: "POST", cuerpo: { filename: "x", size: 1 } })).status,
  401
);

console.log("\nUna subida en vuelo tiene dueño");
// Esto es lo que faltaba. `requireUploadAccess` comprobaba que quien llama tuviera
// ALGUNA credencial válida, no que fuera quien abrió esa subida. Comprobado antes
// de arreglarlo, con dos enlaces de invitado distintos: el segundo escribía el
// trozo 0 del fichero que estaba subiendo el primero, le leía el nombre del
// documento y le cancelaba la subida.
//
// Lo peor no es el estorbo: es que el fichero que acaba llegando no sea el que
// mandó quien lo mandó.
const e1 = await crearEnlace(a, { label: "uno" });
const e2 = await crearEnlace(a, { label: "dos" });
const t1 = e1.body.link.token;
const t2 = e2.body.link.token;

const abierta = await api("/api/upload/init", {
  cabeceras: invitado(t1),
  metodo: "POST",
  cuerpo: { filename: "documento-de-uno.txt", size: 3 * 1024 * 1024 },
});
check("el invitado 1 abre una subida", abierta.status, 200);
const uploadId = abierta.body.uploadId;
// Del tamaño que espera la sesión, no uno cualquiera: con un trozo corto la ruta
// lo rechaza por tamaño ANTES de mirar de quién es, y la comprobación diría "no
// escribe" sin haber probado el permiso.
const trozo = Buffer.alloc(Math.min(abierta.body.chunkSize, 3 * 1024 * 1024), 0x5a);

const escribe = async (cabeceras) =>
  (await fetch(`${BASE}/api/upload/${uploadId}/part/0`, {
    method: "PUT",
    body: trozo,
    headers: { ...cabeceras, "content-type": "application/octet-stream" },
  })).status;

check("el invitado 2 no escribe en ella", await escribe(invitado(t2)), 404);
check("ni una cuenta cualquiera", await escribe({ cookie: b }), 404);
check("el invitado 2 no ve su estado", (await api(`/api/upload/${uploadId}`, { cabeceras: invitado(t2) })).status, 404);
check("ni le lee el nombre del documento", (await api(`/api/upload/${uploadId}`, { cabeceras: invitado(t2) })).body?.originalName ?? null, null);
check("ni la completa", (await api(`/api/upload/${uploadId}/complete`, { cabeceras: invitado(t2), metodo: "POST" })).status, 404);
check("ni la cancela", (await api(`/api/upload/${uploadId}`, { cabeceras: invitado(t2), metodo: "DELETE" })).status, 404);
// Y sigue viva para quien la abrió: un candado que también deja fuera al dueño no
// arregla nada, rompe las subidas.
check("y sigue siendo del invitado 1", (await api(`/api/upload/${uploadId}`, { cabeceras: invitado(t1) })).status, 200);

// El camino entero, del principio al final, por el dueño. Sin esto, todo lo de
// arriba podría estar pasando porque las subidas están rotas del todo.
const TAM = 2 * 1024 * 1024;
const propia = await api("/api/upload/init", {
  cabeceras: invitado(t1),
  metodo: "POST",
  cuerpo: { filename: "entera.bin", size: TAM },
});
const datos = Buffer.alloc(TAM, 0x42);
let trozosOk = true;
for (let i = 0; i < propia.body.totalParts; i++) {
  const desde = i * propia.body.chunkSize;
  const r = await fetch(`${BASE}/api/upload/${propia.body.uploadId}/part/${i}`, {
    method: "PUT",
    body: datos.subarray(desde, Math.min(desde + propia.body.chunkSize, TAM)),
    headers: { ...invitado(t1), "content-type": "application/octet-stream" },
  });
  if (r.status !== 200) trozosOk = false;
}
check("el dueño sí escribe todos sus trozos", trozosOk, true);
const cerrada = await api(`/api/upload/${propia.body.uploadId}/complete`, { cabeceras: invitado(t1), metodo: "POST" });
check("y la cierra", cerrada.status, 200);
const bajada = await fetch(`${BASE}/api/download/${cerrada.body.id}`);
check("y el fichero baja entero", (await bajada.arrayBuffer()).byteLength, TAM);

resumen();
