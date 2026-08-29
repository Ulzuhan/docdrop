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
import { api, check, crearEnlace, crearUsuario, firmar, invitado, resumen, sesion, subir, BASE } from "./comun.mjs";

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

console.log("\nPeticiones simples desde otro origen");
const cruzadas = { Origin: "https://evil.example.com", "Sec-Fetch-Site": "same-site" };
check(
  "un dominio hermano no fuerza una subida directa",
  (await subir(Buffer.from("no debe guardarse"), { cookie: a, cabeceras: cruzadas })).status,
  403
);
check(
  "ni fuerza el barrido",
  (await api("/api/cleanup", { cookie: a, metodo: "POST", cabeceras: cruzadas })).status,
  403
);
const salidaCruzada = await api("/api/auth/logout", {
  cookie: a,
  metodo: "POST",
  cabeceras: cruzadas,
});
check("ni fuerza el cierre de sesión", salidaCruzada.status, 403);
check("y no manda borrar la cookie", salidaCruzada.cab["set-cookie"] ?? null, null);

/**
 * Y la cabecera que decide de dónde viene la petición no la puede escribir quien
 * llama.
 *
 * `X-Forwarded-Host` **no la reemplaza este despliegue**: comprobado en vivo contra
 * el túnel, llega tal cual mientras `Host` sigue valiendo el nombre de verdad.
 * Mientras se prefirió la primera, los tres guardianes se saltaban solos: cerrar la
 * sesión, lanzar la purga y **escribir bytes elegidos por quien llama**.
 *
 * El `Origin` va con el mismo esquema que ve el servidor de pruebas, a propósito:
 * con otro, la comprobación rechazaría por el esquema y este test pasaría aunque el
 * fallo siguiera ahí. Y sin `Sec-Fetch-Site`, que es como llega un navegador que no
 * manda Fetch Metadata: deja sola a la comprobación de origen, que es la que se
 * quiere probar.
 */
const falseada = { Origin: "http://malo.example", "X-Forwarded-Host": "malo.example" };
check(
  "una cabecera X-Forwarded-Host inventada no cuela una subida",
  (await subir(Buffer.from("tampoco debe guardarse"), { cookie: a, cabeceras: falseada })).status,
  403
);
check(
  "ni el barrido",
  (await api("/api/cleanup", { cookie: a, metodo: "POST", cabeceras: falseada })).status,
  403
);
check(
  "ni el cierre de sesión",
  (await api("/api/auth/logout", { cookie: a, metodo: "POST", cabeceras: falseada })).status,
  403
);
check("y la sesión sigue en pie", (await api("/api/files", { cookie: a })).status, 200);

// Cerrar una subida también es un POST sin cuerpo, así que necesitaba el mismo
// guardián y no lo tenía: desde un dominio hermano devolvía 200. La comprobación de
// dueño no ayuda aquí, porque la credencial que viaja es la de la víctima.
const enVuelo = await api("/api/upload/init", {
  cookie: a,
  metodo: "POST",
  cuerpo: { filename: "en-vuelo.bin", size: 1024 },
});
await fetch(`${BASE}/api/upload/${enVuelo.body.uploadId}/part/0`, {
  method: "PUT",
  body: Buffer.alloc(1024, 1),
  headers: { cookie: a, "content-type": "application/octet-stream" },
});
check(
  "un dominio hermano no cierra una subida ajena",
  (await api(`/api/upload/${enVuelo.body.uploadId}/complete`, { cookie: a, metodo: "POST", cabeceras: cruzadas })).status,
  403
);
// Y el dueño sí la cierra: un candado que también deja fuera a quien subió no
// arregla nada, rompe las subidas.
check(
  "pero el dueño sí",
  (await api(`/api/upload/${enVuelo.body.uploadId}/complete`, { cookie: a, metodo: "POST" })).status,
  200
);

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

/**
 * El inquilino, no solo la puerta.
 *
 * Esto no existía y era el fallo de fondo de la herramienta: cualquier cuenta
 * veía, podía descargar desde el panel y podía borrar los ficheros de todas las
 * demás — y lo mismo con los enlaces de invitado. Lo encontró el operador el
 * primer día que hubo un segundo usuario real: el fichero del otro, en su
 * panel. Estas comprobaciones son las que faltaban.
 */
console.log("\nCada cuenta ve lo suyo, y solo lo suyo");
const cookieA = sesion("usuario-a");
const cookieB = sesion("usuario-b");

const deA = await subir("contenido de a", { cookie: cookieA, nombre: "de-a.txt" });
check("a sube", deA.status, 200);
const deB = await subir("contenido de b", { cookie: cookieB, nombre: "de-b.txt" });
check("b sube", deB.status, 200);

const listaA = await api("/api/files", { cookie: cookieA });
const listaB = await api("/api/files", { cookie: cookieB });
const nombresA = listaA.body.files.map((f) => f.originalName);
const nombresB = listaB.body.files.map((f) => f.originalName);
check("a ve su fichero", nombresA.includes("de-a.txt"), true);
check("a NO ve el de b", nombresA.includes("de-b.txt"), false);
check("b ve el suyo", nombresB.includes("de-b.txt"), true);
check("b NO ve el de a", nombresB.includes("de-a.txt"), false);

// Borrar lo ajeno contesta lo mismo que borrar lo inexistente: nada que sondear.
const borraAjeno = await api(`/api/files/${deA.body.id}`, { cookie: cookieB, metodo: "DELETE" });
check("b no puede borrar el fichero de a", borraAjeno.status, 404);
const sigue = await fetch(`${BASE}/api/download/${deA.body.id}`);
check("y el fichero de a sigue vivo", sigue.status, 200);
check("a sí borra el suyo", (await api(`/api/files/${deA.body.id}`, { cookie: cookieA, metodo: "DELETE" })).status, 200);

// El enlace directo sigue siendo la capacidad: quien lo tiene, descarga. Eso no
// cambia — lo que cambia es que el panel ya no regala los enlaces de todos.
console.log("\nLos enlaces de invitado también son de quien los emite");
const enlaceA = await crearEnlace(cookieA);
check("a emite un enlace", enlaceA.status, 201);
const tokenA = enlaceA.body.link.token;

const enlacesDeB = await api("/api/guest-links", { cookie: cookieB });
check("b no ve el enlace de a", enlacesDeB.body.links.some((l) => l.token === tokenA), false);
check("b no puede revocar el enlace de a", (await api(`/api/guest-links/${tokenA}`, { cookie: cookieB, metodo: "DELETE" })).status, 404);

// Y lo subido por el enlace aparece en el panel de quien lo repartió, no en otro.
const porInvitado = await subir("subida de un invitado", { cabeceras: invitado(tokenA), nombre: "invitado.txt" });
check("el invitado sube por el enlace de a", porInvitado.status, 200);
const panelA = await api("/api/files", { cookie: cookieA });
const panelB = await api("/api/files", { cookie: cookieB });
check("a ve lo que entró por su enlace", panelA.body.files.some((f) => f.originalName === "invitado.txt"), true);
check("b no lo ve", panelB.body.files.some((f) => f.originalName === "invitado.txt"), false);
check("a revoca su propio enlace", (await api(`/api/guest-links/${tokenA}`, { cookie: cookieA, metodo: "DELETE" })).status, 200);

resumen();
