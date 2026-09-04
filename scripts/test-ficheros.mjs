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

// Aquí decía «un buzón compartido: quien tiene cuenta ve y borra todo. Es a
// propósito y se comprueba para que un cambio de idea se note aquí y no en
// producción». El cambio de idea llegó, y llegó por producción: el primer
// segundo usuario real subió un fichero y el operador lo vio en su panel. La
// premisa —«las altas las aprueba una persona, luego todo el que entra es de
// confianza»— confundía dejar entrar con compartir habitación. Ahora cada
// cuenta ve lo suyo, y esta comprobación fija el modelo nuevo con la misma
// intención que la vieja fijaba el anterior.
check("otra cuenta NO lo ve en la lista", (await api("/api/files", { cookie: b })).body.files.some((f) => f.id === id), false);
check("pero el enlace directo le funciona igual: el enlace es el permiso", (await fetch(`${BASE}/api/download/${id}`)).status, 200);

console.log("\nLa autodestrucción");
const dos = await subir(Buffer.from("se borra a la segunda"), { cookie: a, nombre: "dos.txt", extra: { "x-max-downloads": "2" } });
check("se puede pedir un tope de descargas", dos.body?.maxDownloads, 2);
// Una descarga cuenta cuando ha llegado entera (la prueba de una cortada a
// mitad está en la suite e2ee, con un fichero mayor que los búferes): aquí se
// consume cada cuerpo, que es lo que la hace contar.
const codigos = [];
for (let i = 0; i < 3; i++) {
  const r = await fetch(`${BASE}/api/download/${dos.body.id}`);
  codigos.push(r.status);
  if (r.ok) await r.arrayBuffer(); // consumir entera: es lo que la hace contar
  await new Promise((rr) => setTimeout(rr, 100));
}
check("dos descargas enteras y a la tercera se acabó", codigos, [200, 200, 410]);
check("y ya no aparece en la lista", (await api("/api/files", { cookie: a })).body.files.some((f) => f.id === dos.body.id), false);

console.log("\nUn Range inválido no regala reanudaciones");
const unica = await subir(Buffer.from("una sola descarga"), { cookie: a, nombre: "una.bin", extra: { "x-max-downloads": "1" } });
check("el fichero tiene una sola descarga", unica.body?.maxDownloads, 1);
const rutaUnica = `${BASE}/api/download/${unica.body.id}`;
check("el rango mal formado se rechaza", (await fetch(rutaUnica, { headers: { Range: "bytes=invalid" } })).status, 416);
const valida = await fetch(rutaUnica, { headers: { Range: "bytes=0-" } });
check("el error anterior no bloquea la descarga", valida.status, 206);
check("se entrega todo el fichero", await valida.text(), "una sola descarga");
check("y esta sí agota el presupuesto", (await fetch(rutaUnica, { headers: { Range: "bytes=0-" } })).status, 410);

console.log("\nLo que /api/info cuenta, y lo que no");
const publico = (await api(`/api/info/${id}`)).body;
check("no dice de quién es el fichero", "owner" in publico, false);
check("sí dice quién lo subió, por su cuenta", typeof publico.uploadedBy, "string");
const disfraz = await subir(Buffer.from("firmado como otro"), { cookie: a, nombre: "disfraz.txt", extra: { "x-uploaded-by": "Mallory" } });
check("el nombre que manda el cliente se ignora: manda la cuenta", (await api(`/api/info/${disfraz.body.id}`)).body.uploadedBy === "Mallory", false);

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


console.log("\nUna subida lenta no para a las demás");
// La carrera de la cuota se cierra apartando el sitio bajo el candado. Lo que NO
// puede hacerse es sostener el candado mientras el cuerpo va llegando: eso cierra
// la carrera y de paso serializa la aplicación entera. Medido cuando estuvo así:
// una subida de 1 MB tardaba 3,2 segundos esperando a otra que goteaba, y con un
// fichero de varios gigas desde una casa eso son minutos con todo el mundo parado.
// En una herramienta que existe para ficheros grandes, eso no vale.
//
// El umbral tiene margen de sobra: con el arreglo puesto la rápida tarda unos 16 ms
// y la lenta unos 3,5 segundos. Cualquier valor entre medias sirve.
// Trozos pequeños a propósito. Esta suite corre con una cuota de 1 MiB para poder
// probar el desbordamiento más abajo, y lo que suba esta prueba se queda ocupando
// sitio: con 64 KB por trozo se comía 384 KB de ese millón. No llegó a romper
// nada, pero acoplar dos pruebas por el espacio que dejan es pedir un fallo
// intermitente más adelante.
const TROZOS = 6;
const POR_TROZO = 8 * 1024;
const goteo = (trozos, msEntre) =>
  new ReadableStream({
    async pull(c) {
      this.i ??= 0;
      if (this.i >= trozos) return c.close();
      if (this.i > 0) await new Promise((r) => setTimeout(r, msEntre));
      c.enqueue(new Uint8Array(POR_TROZO));
      this.i++;
    },
  });

// Con `Content-Length` declarado, que es lo que manda un navegador subiendo un
// fichero. Importa: sin declararlo, una subida aparta todo el hueco que queda —la
// opción conservadora, porque no se sabe cuánto va a ocupar— y en esta suite, que
// corre con una cuota de 1 MiB a propósito, eso deja fuera a las demás. Declarado,
// aparta lo suyo y ya está.
const lenta = fetch(`${BASE}/api/upload`, {
  method: "POST",
  body: goteo(TROZOS, 500),
  duplex: "half",
  headers: {
    cookie: a,
    "x-filename": "lenta.bin",
    "content-type": "application/octet-stream",
    "content-length": String(TROZOS * POR_TROZO),
  },
}).then((r) => r.text());

await new Promise((r) => setTimeout(r, 300));
const t0 = Date.now();
const rapida = await subir(Buffer.from("pequeña"), { cookie: a, nombre: "rapida.txt" });
const tardo = Date.now() - t0;
await lenta;
nota("la rápida, con una lenta en curso", `${rapida.status} en ${tardo} ms`);
check("la rápida no espera a la lenta", tardo < 1000, true);
check("y entra igual", rapida.status, 200);

console.log("\nLa cuota con dos subidas a la vez");
const carrera = await Promise.all([
  subir(Buffer.alloc(600 * 1024, 0x41), { cookie: a, nombre: "carrera-a.bin" }),
  subir(Buffer.alloc(600 * 1024, 0x42), { cookie: a, nombre: "carrera-b.bin" }),
]);
check(
  "sólo una reserva el espacio disponible",
  carrera.map((r) => r.status).sort((x, y) => x - y),
  [200, 507]
);
const ganadora = carrera.find((r) => r.status === 200)?.body?.id;
check(
  "el almacén no supera el MiB configurado",
  (await api("/api/files", { cookie: a })).body.storage.usedBytes <= 1024 * 1024,
  true
);
if (ganadora) await api(`/api/files/${ganadora}`, { cookie: a, metodo: "DELETE" });
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
