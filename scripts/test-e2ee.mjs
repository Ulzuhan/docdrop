/**
 * El cifrado, medido donde importa: en el disco del servidor.
 *
 * Sube un fichero con un marcador conocido POR EL MISMO CAMINO que el navegador
 * (el módulo e2ee de verdad, importado con --experimental-strip-types), y después
 * mira el almacén: el marcador no puede estar. Luego baja el bulto por la API
 * pública y lo abre con la clave — la ida y vuelta completa, sin navegador.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { api, check, crearUsuario, resumen, sesion, BASE } from "./comun.mjs";
import {
  cifrarFichero,
  claveAFragmento,
  claveDesdeFragmento,
  descifrarFichero,
  nuevaClave,
  leerPrefijo,
  descifrarCabecera,
} from "../src/lib/e2ee.ts";

const DATOS = process.env.DOCDROP_DATA_DIR;
if (!DATOS) {
  console.error("esta suite necesita DOCDROP_DATA_DIR (la levanta run-suites.sh)");
  process.exit(1);
}

await crearUsuario("usuario-e2ee");
const cookie = sesion("usuario-e2ee");

const MARCADOR = "EL-CLARO-NO-PUEDE-TOCAR-EL-DISCO-9f3a1c";
const claro = new TextEncoder().encode(`${MARCADOR} `.repeat(200));

console.log("La subida cifrada, con el módulo de verdad");
const clave = nuevaClave();
const bulto = await cifrarFichero(
  clave,
  { name: "confidencial.txt", mimeType: "text/plain", size: claro.length },
  claro
);

const res = await fetch(`${BASE}/api/upload`, {
  method: "POST",
  body: bulto,
  headers: {
    cookie,
    "x-filename": "encrypted",
    "content-type": "application/octet-stream",
    "x-docdrop-encrypted": "1",
  },
});
const subida = await res.json();
check("el bulto sube", res.status, 200);
const id = subida.id;
check("con identificador", typeof id, "string");

console.log("\nEl disco, registrado entero");
let claroEnDisco = false;
let nombreEnDisco = false;
async function barrer(dir) {
  for (const entrada of await readdir(dir, { withFileTypes: true })) {
    const ruta = join(dir, entrada.name);
    if (entrada.isDirectory()) await barrer(ruta);
    else {
      const contenido = await readFile(ruta);
      if (contenido.includes(MARCADOR)) claroEnDisco = true;
      if (contenido.includes("confidencial")) nombreEnDisco = true;
    }
  }
}
await barrer(DATOS);
check("el marcador NO está en ningún fichero del almacén", claroEnDisco, false);
check("el nombre de verdad tampoco", nombreEnDisco, false);

console.log("\nLo que el servidor cuenta de él");
const info = await api(`/api/info/${id}`);
check("la marca de cifrado viaja", info.body.encrypted, true);
check("el nombre que enseña es el marcador neutro", info.body.originalName, "encrypted");
check("y el tipo, opaco", info.body.mimeType, "application/octet-stream");
// La cabecera cifrada viaja con la info: es ciphertext, y es lo que deja a
// quien tiene la clave ver nombre, tipo y tamaño ANTES de gastar una descarga.
check("y trae la cabecera cifrada", typeof info.body.header, "string");
const prefijo = leerPrefijo(new Uint8Array(Buffer.from(info.body.header, "base64")));
check("que es un prefijo nuestro", prefijo !== null, true);
const cabeceraAbierta = await descifrarCabecera(clave, prefijo.cabeceraCifrada);
check("y la clave la abre: el nombre de verdad, sin descargar", cabeceraAbierta.name, "confidencial.txt");
let ajenaCabecera = "abre";
try { await descifrarCabecera(nuevaClave(), prefijo.cabeceraCifrada); } catch { ajenaCabecera = "no abre"; }
check("otra clave no abre la cabecera", ajenaCabecera, "no abre");

console.log("\nUna descarga cuenta cuando ha llegado entera");
// Lo que enseñó el primer envío real a un teléfono: el móvil pidió el bulto,
// no supo convertirlo en fichero, y la única descarga permitida se había ido.
// Un bulto mayor que los búferes de socket del loopback, para que «leído un
// trozo y cortado» no pueda confundirse con «entregado».
const GRANDE = 24 * 1024 * 1024;
const grande = await cifrarFichero(clave, { name: "grande.bin", mimeType: "application/octet-stream", size: GRANDE }, new Uint8Array(GRANDE));
const subidaGrande = await (await fetch(`${BASE}/api/upload`, {
  method: "POST",
  body: grande,
  headers: { cookie, "x-filename": "encrypted", "content-type": "application/octet-stream", "x-docdrop-encrypted": "1", "x-max-downloads": "1" },
})).json();
check("el bulto grande sube con una sola descarga permitida", subidaGrande.maxDownloads, 1);
const cortada = await fetch(`${BASE}/api/download/${subidaGrande.id}`);
check("la descarga arranca", cortada.status, 200);
const lector = cortada.body.getReader();
await lector.read();
await lector.cancel();
await new Promise((r) => setTimeout(r, 500));
check("cortada a mitad, NO cuenta", (await api(`/api/info/${subidaGrande.id}`)).body.downloadCount, 0);
const entera = await fetch(`${BASE}/api/download/${subidaGrande.id}`);
check("y la siguiente sigue disponible", entera.status, 200);
check("llega entera", (await entera.arrayBuffer()).byteLength, grande.length);
await new Promise((r) => setTimeout(r, 300));
check("ahora sí cuenta, y era la última: se acabó", (await fetch(`${BASE}/api/download/${subidaGrande.id}`)).status, 410);

console.log("\nLa vuelta: el enlace completo abre; el incompleto no");
const bajada = await fetch(`${BASE}/api/download/${id}`);
check("el bulto baja sin cuenta (el enlace es el permiso)", bajada.status, 200);
const recibido = new Uint8Array(await bajada.arrayBuffer());
const abierto = await descifrarFichero(claveDesdeFragmento(claveAFragmento(clave)), recibido);
check("se abre con la clave del fragmento", abierto !== null, true);
check("el nombre de verdad estaba dentro", abierto?.cabecera.name, "confidencial.txt");
check(
  "y el contenido vuelve idéntico",
  Buffer.from(abierto?.datos ?? []).equals(Buffer.from(claro)),
  true
);

const ajena = await descifrarFichero(nuevaClave(), recibido).catch(() => null);
check("otra clave no abre nada", ajena, null);

resumen();
