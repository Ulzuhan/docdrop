/**
 * El ciclo de un fichero, y lo que se le manda al servidor.
 *
 * Descargar es público por diseño: el identificador ES el secreto, como en
 * cualquier enlace de "compartir". Eso hace que su validación no sea cosmética —
 * todo lo que hay detrás es alcanzable desde internet por cualquiera— y que la
 * autodestrucción tenga que cumplirse de verdad, porque es lo que promete.
 */
import { api, check, crearUsuario, nota, resumen, sesion, subir, BASE } from "./comun.mjs";

await crearUsuario("usuario-a");
await crearUsuario("usuario-b");
const a = sesion("usuario-a");
const b = sesion("usuario-b");

console.log("El ciclo de un fichero");
const contenido = Buffer.from("contenido de prueba ".repeat(50));
const puesto = await subir(contenido, { cookie: a, nombre: "documento.txt" });
check("se sube", puesto.status, 200);
const id = puesto.body?.id;
check("y devuelve un identificador", typeof id, "string");

const bajada = await fetch(`${BASE}/api/download/${id}`);
check("se descarga sin sesión: el enlace es el permiso", bajada.status, 200);
const bytes = await bajada.arrayBuffer();
check("y llega entero", bytes.byteLength, contenido.length);
check("con el nombre puesto", /filename="documento.txt"/.test(bajada.headers.get("content-disposition") ?? ""), true);

// Un buzón compartido: quien tiene cuenta ve y borra todo. Es a propósito —las
// altas las aprueba una persona— y se comprueba para que un cambio de idea se
// note aquí y no en producción.
check("otra cuenta también lo ve en la lista", (await api("/api/files", { cookie: b })).body.files.some((f) => f.id === id), true);

console.log("\nLa autodestrucción");
const dos = await subir(Buffer.from("se borra a la segunda"), { cookie: a, nombre: "dos.txt", extra: { "x-max-downloads": "2" } });
check("se puede pedir un tope de descargas", dos.body?.maxDownloads, 2);
const codigos = [];
for (let i = 0; i < 3; i++) codigos.push((await fetch(`${BASE}/api/download/${dos.body.id}`)).status);
check("dos descargas y a la tercera se acabó", codigos, [200, 200, 410]);
check("y ya no aparece en la lista", (await api("/api/files", { cookie: a })).body.files.some((f) => f.id === dos.body.id), false);

console.log("\nIdentificadores que vienen de la URL");
for (const ruta of ["/api/download", "/api/info"]) {
  for (const id of [
    "../../etc/passwd",
    "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "....//....//etc",
    "con espacio",
    "%00AAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAA",
  ]) {
    check(`${ruta} con ${JSON.stringify(id.slice(0, 24))} da 404`, (await api(`${ruta}/${encodeURIComponent(id)}`)).status, 404);
  }
}

console.log("\nCuerpos que no se entienden");
// `null` es JSON válido, así que `json()` no protesta y devuelve null; el `catch`
// no se entera y quien lee `body.filename` se lleva un TypeError. Daba 500 en las
// dos rutas que leen JSON. Y `/api/guest-links` aceptaba `[1,2]` y creaba el
// enlace con todo por defecto.
//
// Exigir `application/json` es además lo que corta el CSRF entre los servicios de
// este dominio: son el mismo sitio para el navegador, así que la cookie viaja, y
// sólo `text/plain`, `multipart` y los formularios salen sin que pregunte antes.
for (const ruta of ["/api/upload/init", "/api/guest-links"]) {
  for (const [que, cuerpo, tipo] of [
    ["a medias", "{no-es-json", "application/json"],
    ["vacío", "", "application/json"],
    ["el texto null", "null", "application/json"],
    ["una lista", "[1,2]", "application/json"],
    ["texto suelto", "hola", "text/plain"],
    ["un formulario", "filename=x&size=1", "application/x-www-form-urlencoded"],
  ]) {
    const r = await api(ruta, { cookie: a, metodo: "POST", cuerpo, tipo });
    check(`${ruta} con un cuerpo ${que} da 400, no 500`, r.status, 400);
  }
}
check(
  "y con el juego de caracteres detrás sigue valiendo",
  (await api("/api/upload/init", {
    cookie: a,
    metodo: "POST",
    tipo: "application/json; charset=utf-8",
    cuerpo: { filename: "vale.txt", size: 1024 },
  })).status,
  200
);

console.log("\nLos topes al subir");
check(
  "un tamaño que no es número se rechaza",
  (await api("/api/upload/init", { cookie: a, metodo: "POST", cuerpo: { filename: "x.txt", size: "grande" } })).status,
  400
);
check(
  "uno negativo también",
  (await api("/api/upload/init", { cookie: a, metodo: "POST", cuerpo: { filename: "x.txt", size: -5 } })).status,
  400
);
check(
  "y uno absurdo no cabe",
  (await api("/api/upload/init", { cookie: a, metodo: "POST", cuerpo: { filename: "x.txt", size: 999 * 1024 * 1024 * 1024 } })).status,
  413
);
check(
  "sin nombre no hay fichero",
  (await api("/api/upload/init", { cookie: a, metodo: "POST", cuerpo: { size: 1024 } })).status,
  400
);

console.log("\nEl nombre del fichero que vuelve");
// Una cabecera HTTP sólo admite bytes 0–255, así que un nombre con acentos o con
// saltos de línea es por donde se colaría una cabecera entera si nadie mirase.
// Sin `\r\n`: el propio `fetch` se niega a mandar una cabecera que los lleve, y
// los navegadores igual, así que ese caso no llega ni a salir del cliente. Lo que
// sí viaja —y es el riesgo de verdad, porque el servidor lo devuelve dentro de
// `Content-Disposition`— son las comillas, el punto y coma y los acentos.
const raro = await subir(Buffer.from("x"), { cookie: a, nombre: 'añó "raro"; X-Inyectada: si.txt' });
if (raro.body?.id) {
  const r = await fetch(`${BASE}/api/download/${raro.body.id}`);
  nota("content-disposition", r.headers.get("content-disposition"));
  check("no nace ninguna cabecera nueva", r.headers.get("x-inyectada"), null);
  check("las comillas no rompen la estructura", (r.headers.get("content-disposition") ?? "").split('"').length, 3);
  check("ni quedan saltos de línea sueltos", /[\r\n]/.test(r.headers.get("content-disposition") ?? ""), false);
  check("y hay un nombre ASCII de repuesto", /filename="/.test(r.headers.get("content-disposition") ?? ""), true);
}

resumen();
