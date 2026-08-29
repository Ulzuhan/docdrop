/**
 * Cifrado de punta a punta de DocDrop. El plan entero: kaicorplabs/docs/24.
 *
 * El servidor pasa de custodiar ficheros a custodiar bultos que no puede abrir:
 * la clave nace en el navegador de quien sube y viaja en el fragmento del enlace
 * (`/d/<id>#<clave>`), el trozo de URL que el navegador nunca manda a ningún
 * servidor. Este módulo es TODO el cifrado — las rutas y las páginas lo importan,
 * y no hay ninguna otra pieza que toque una clave.
 *
 * Isomorfo a propósito: solo usa WebCrypto (`globalThis.crypto`), que existe
 * igual en el navegador y en Node ≥20. Es lo que permite que las suites importen
 * este mismo fichero y prueben el cifrado de verdad, no un doble.
 *
 * ── El formato del bulto ────────────────────────────────────────────────────
 *
 *   "DDE1"      4 B   magia + versión del formato
 *   chunkSize   4 B   tamaño del trozo EN CLARO, big-endian (no es secreto)
 *   hdrLen      4 B   longitud de la cabecera cifrada, big-endian
 *   cabecera    hdrLen B   AES-GCM de un JSON {name, mimeType, size}
 *   trozos      N × (chunkSize + 16) B, el último más corto
 *
 * ── Las decisiones que no son evidentes ─────────────────────────────────────
 *
 * AES-256-GCM POR TROZOS y no de una pieza: un fichero de gigas no cabe en la
 * memoria de un navegador, y GCM en WebCrypto es de una pasada — trocear es lo
 * que permite cifrar y descifrar en flujo (F2 del plan).
 *
 * NONCE DETERMINISTA POR ÍNDICE (12 B: 4 de dominio + 8 de índice big-endian).
 * Único por clave, porque la clave es aleatoria por fichero y jamás se reusa —
 * y determinista a propósito: reintentar un trozo en una reanudación produce
 * exactamente el mismo ciphertext, así que el protocolo de subida troceada que
 * ya existe no tiene que cambiar. Los 4 bytes de dominio separan la cabecera
 * (0xFF…) de los datos (0x00…): ni con la misma clave pueden confundirse.
 *
 * AAD POR TROZO = versión + índice + marca-de-último. Es lo que un cifrado por
 * trozos ingenuo no da: sin el índice, el servidor podría REORDENAR trozos y el
 * descifrado no se enteraría; sin la marca de último, podría TRUNCAR el fichero
 * en una frontera de trozo y entregar un prefijo válido. Con esto, cualquier
 * recolocación, recorte o extensión rompe la verificación del GCM.
 *
 * El id del fichero NO va en el AAD, y no es un olvido: la clave es aleatoria
 * por fichero, así que un bulto ajeno no se descifra con esta clave lo etiquete
 * como se etiquete — y en la subida directa el id ni existe todavía cuando se
 * cifra.
 *
 * EL NOMBRE Y EL TIPO VAN DENTRO. `originalName` y `mimeType` son a menudo tan
 * delatores como el contenido («despido_juan.pdf»). En el meta del servidor
 * quedan un marcador y `application/octet-stream`; los de verdad viajan en la
 * cabecera cifrada y solo los ve quien tiene el enlace.
 */

const MAGIA = new TextEncoder().encode("DDE1");
const VERSION = 1;

/** Trozo en claro de 4 MiB: cabe holgado en memoria y da progreso fino. */
export const TROZO_CLARO = 4 * 1024 * 1024;
/** La etiqueta de autenticación del GCM, al final de cada trozo cifrado. */
export const ETIQUETA = 16;

const DOMINIO_DATOS = 0x00;
const DOMINIO_CABECERA = 0xff;

/** Lo que la cabecera cifrada transporta: lo que el servidor ya no puede ver. */
export interface CabeceraE2EE {
  name: string;
  mimeType: string;
  /** Tamaño EN CLARO. También dice cuántos trozos hay y cuál es el último. */
  size: number;
}

// ─── La clave y su viaje en el fragmento ────────────────────────────────────

export function nuevaClave(): Uint8Array {
  const clave = new Uint8Array(32);
  globalThis.crypto.getRandomValues(clave);
  return clave;
}

export function claveAFragmento(clave: Uint8Array): string {
  let binario = "";
  for (const byte of clave) binario += String.fromCharCode(byte);
  return btoa(binario).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Null si el fragmento no es una clave: un enlace recortado no debe reventar. */
export function claveDesdeFragmento(fragmento: string): Uint8Array | null {
  const limpio = fragmento.replace(/^#/, "");
  if (!/^[A-Za-z0-9_-]{43}$/.test(limpio)) return null;
  try {
    const binario = atob(limpio.replaceAll("-", "+").replaceAll("_", "/"));
    const clave = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i++) clave[i] = binario.charCodeAt(i);
    return clave.length === 32 ? clave : null;
  } catch {
    return null;
  }
}

async function importar(clave: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    clave as unknown as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

// ─── Nonce y AAD: dónde vive la resistencia a reordenar y truncar ───────────

function nonce(dominio: number, indice: number): Uint8Array {
  const n = new Uint8Array(12);
  n.fill(dominio, 0, 4);
  // Índice en big-endian sobre los 8 últimos bytes. Number llega de sobra: un
  // fichero de 2^53 trozos de 4 MiB no cabe en ningún disco de esta casa.
  const vista = new DataView(n.buffer);
  vista.setUint32(4, Math.floor(indice / 2 ** 32));
  vista.setUint32(8, indice >>> 0);
  return n;
}

function aadTrozo(indice: number, esUltimo: boolean): Uint8Array {
  const aad = new Uint8Array(10);
  aad[0] = VERSION;
  aad[1] = esUltimo ? 1 : 0;
  const vista = new DataView(aad.buffer);
  vista.setUint32(2, Math.floor(indice / 2 ** 32));
  vista.setUint32(6, indice >>> 0);
  return aad;
}

const AAD_CABECERA = new Uint8Array([VERSION, DOMINIO_CABECERA]);

// ─── Trozos ─────────────────────────────────────────────────────────────────

export async function cifrarTrozo(
  clave: Uint8Array,
  claro: Uint8Array,
  indice: number,
  esUltimo: boolean
): Promise<Uint8Array> {
  const k = await importar(clave);
  const cifrado = await globalThis.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce(DOMINIO_DATOS, indice) as unknown as ArrayBuffer,
      additionalData: aadTrozo(indice, esUltimo) as unknown as ArrayBuffer,
    },
    k,
    claro as unknown as ArrayBuffer
  );
  return new Uint8Array(cifrado);
}

/** Lanza si el trozo fue manipulado, movido de sitio, o miente sobre ser el último. */
export async function descifrarTrozo(
  clave: Uint8Array,
  cifrado: Uint8Array,
  indice: number,
  esUltimo: boolean
): Promise<Uint8Array> {
  const k = await importar(clave);
  const claro = await globalThis.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: nonce(DOMINIO_DATOS, indice) as unknown as ArrayBuffer,
      additionalData: aadTrozo(indice, esUltimo) as unknown as ArrayBuffer,
    },
    k,
    cifrado as unknown as ArrayBuffer
  );
  return new Uint8Array(claro);
}

// ─── La cabecera ────────────────────────────────────────────────────────────

export async function cifrarCabecera(clave: Uint8Array, cabecera: CabeceraE2EE): Promise<Uint8Array> {
  const k = await importar(clave);
  const claro = new TextEncoder().encode(JSON.stringify(cabecera));
  const cifrado = await globalThis.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce(DOMINIO_CABECERA, 0) as unknown as ArrayBuffer,
      additionalData: AAD_CABECERA as unknown as ArrayBuffer,
    },
    k,
    claro as unknown as ArrayBuffer
  );
  return new Uint8Array(cifrado);
}

export async function descifrarCabecera(clave: Uint8Array, cifrada: Uint8Array): Promise<CabeceraE2EE> {
  const k = await importar(clave);
  const claro = await globalThis.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: nonce(DOMINIO_CABECERA, 0) as unknown as ArrayBuffer,
      additionalData: AAD_CABECERA as unknown as ArrayBuffer,
    },
    k,
    cifrada as unknown as ArrayBuffer
  );
  return JSON.parse(new TextDecoder().decode(claro)) as CabeceraE2EE;
}

// ─── El prefijo del bulto ───────────────────────────────────────────────────

export function empaquetarPrefijo(cabeceraCifrada: Uint8Array, trozoClaro: number): Uint8Array {
  const prefijo = new Uint8Array(12 + cabeceraCifrada.length);
  prefijo.set(MAGIA, 0);
  const vista = new DataView(prefijo.buffer);
  vista.setUint32(4, trozoClaro);
  vista.setUint32(8, cabeceraCifrada.length);
  prefijo.set(cabeceraCifrada, 12);
  return prefijo;
}

/** Null si esto no es un bulto nuestro: la descarga cae al camino sin cifrar. */
export function leerPrefijo(
  bytes: Uint8Array
): { trozoClaro: number; cabeceraCifrada: Uint8Array; datosDesde: number } | null {
  if (bytes.length < 12) return null;
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIA[i]) return null;
  const vista = new DataView(bytes.buffer, bytes.byteOffset);
  const trozoClaro = vista.getUint32(4);
  const hdrLen = vista.getUint32(8);
  if (trozoClaro < 1024 || hdrLen < ETIQUETA || bytes.length < 12 + hdrLen) return null;
  return {
    trozoClaro,
    cabeceraCifrada: bytes.slice(12, 12 + hdrLen),
    datosDesde: 12 + hdrLen,
  };
}

// ─── El fichero entero, para lo que cabe en memoria (F1) ────────────────────
//
// F2 cifra y descifra en flujo con las piezas de arriba; estas dos funciones
// son el mismo formato de una sentada, y son las que usan las suites.

export async function cifrarFichero(
  clave: Uint8Array,
  cabecera: CabeceraE2EE,
  datos: Uint8Array,
  trozoClaro = TROZO_CLARO
): Promise<Uint8Array> {
  const partes: Uint8Array[] = [empaquetarPrefijo(await cifrarCabecera(clave, cabecera), trozoClaro)];
  const total = Math.max(1, Math.ceil(datos.length / trozoClaro));
  for (let i = 0; i < total; i++) {
    const claro = datos.slice(i * trozoClaro, Math.min((i + 1) * trozoClaro, datos.length));
    partes.push(await cifrarTrozo(clave, claro, i, i === total - 1));
  }
  const longitud = partes.reduce((suma, p) => suma + p.length, 0);
  const bulto = new Uint8Array(longitud);
  let desplazamiento = 0;
  for (const parte of partes) {
    bulto.set(parte, desplazamiento);
    desplazamiento += parte.length;
  }
  return bulto;
}

/**
 * El descifrado en flujo: un bulto de gigas sin tenerlo entero en ningún sitio.
 *
 * Consume el stream del ciphertext (lo que da `fetch(...).body`) y produce el
 * claro trozo a trozo. Es la pieza de la descarga por service worker (F2 de
 * docs/24): el navegador escribe cada trozo descifrado a disco según llega.
 *
 * Las mismas garantías que la versión de una sentada, en el mismo orden en que
 * el peligro aparece: la cabecera se verifica antes de emitir ningún byte, cada
 * trozo salta si fue manipulado o movido, un stream que se corta antes del
 * último trozo termina en error —nunca en un fichero a medias entregado como
 * entero—, y bytes de más tras el último trozo también son error.
 */
export async function abrirFlujo(
  clave: Uint8Array,
  bulto: ReadableStream<Uint8Array>
): Promise<{ cabecera: CabeceraE2EE; datos: ReadableStream<Uint8Array> } | null> {
  const lector = bulto.getReader();
  let resto = new Uint8Array(0);
  let acabado = false;

  async function leerHasta(n: number): Promise<boolean> {
    while (resto.length < n && !acabado) {
      const { value, done } = await lector.read();
      if (done) {
        acabado = true;
        break;
      }
      const junto = new Uint8Array(resto.length + value.length);
      junto.set(resto, 0);
      junto.set(value, resto.length);
      resto = junto;
    }
    return resto.length >= n;
  }

  // El prefijo: bastan 12 bytes para saber cuánta cabecera pedir.
  if (!(await leerHasta(12))) return null;
  const vista = new DataView(resto.buffer, resto.byteOffset);
  let magiaOk = true;
  for (let i = 0; i < 4; i++) if (resto[i] !== MAGIA[i]) magiaOk = false;
  if (!magiaOk) return null;
  const trozoClaro = vista.getUint32(4);
  const hdrLen = vista.getUint32(8);
  if (trozoClaro < 1024 || hdrLen < ETIQUETA) return null;
  if (!(await leerHasta(12 + hdrLen))) return null;

  const cabecera = await descifrarCabecera(clave, resto.slice(12, 12 + hdrLen));
  resto = resto.slice(12 + hdrLen);

  const totalTrozos = Math.max(1, Math.ceil(cabecera.size / trozoClaro));
  let indice = 0;

  const datos = new ReadableStream<Uint8Array>({
    pull: async (controlador) => {
      if (indice >= totalTrozos) {
        // Bytes de más tras el último trozo = extensión: también manipulación.
        if (resto.length > 0 || (await leerHasta(1))) {
          controlador.error(new Error("Trailing bytes after final chunk"));
          return;
        }
        controlador.close();
        return;
      }
      const esUltimo = indice === totalTrozos - 1;
      const tamanoClaro = esUltimo ? cabecera.size - indice * trozoClaro : trozoClaro;
      const necesita = tamanoClaro + ETIQUETA;
      if (!(await leerHasta(necesita))) {
        controlador.error(new Error("Truncated stream"));
        return;
      }
      const cifrado = resto.slice(0, necesita);
      resto = resto.slice(necesita);
      controlador.enqueue(await descifrarTrozo(clave, cifrado, indice, esUltimo));
      indice++;
    },
    cancel: () => lector.cancel().catch(() => {}),
  });

  return { cabecera, datos };
}

/** Lanza ante cualquier manipulación; null solo si el bulto no es del formato. */
export async function descifrarFichero(
  clave: Uint8Array,
  bulto: Uint8Array
): Promise<{ cabecera: CabeceraE2EE; datos: Uint8Array } | null> {
  const prefijo = leerPrefijo(bulto);
  if (!prefijo) return null;
  const cabecera = await descifrarCabecera(clave, prefijo.cabeceraCifrada);

  const totalTrozos = Math.max(1, Math.ceil(cabecera.size / prefijo.trozoClaro));
  const datos = new Uint8Array(cabecera.size);
  let leido = prefijo.datosDesde;
  let escrito = 0;
  for (let i = 0; i < totalTrozos; i++) {
    const esUltimo = i === totalTrozos - 1;
    const tamanoClaro = esUltimo ? cabecera.size - i * prefijo.trozoClaro : prefijo.trozoClaro;
    const cifrado = bulto.slice(leido, leido + tamanoClaro + ETIQUETA);
    const claro = await descifrarTrozo(clave, cifrado, i, esUltimo);
    datos.set(claro, escrito);
    leido += cifrado.length;
    escrito += claro.length;
  }
  // Bytes de más tras el último trozo = extensión: también es manipulación.
  if (leido !== bulto.length) throw new Error("Trailing bytes after final chunk");
  return { cabecera, datos };
}
