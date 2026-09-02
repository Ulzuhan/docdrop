"use client";

/**
 * El lado del navegador del cifrado: la fuente cifrada y el llavero local.
 *
 * LA FUENTE CIFRADA es la idea que hace que el transporte no cambie. El cliente
 * troceado sube "un fichero" por rangos de bytes (`slice(start, end)`); esto le
 * da un fichero que no existe — el bulto cifrado — materializando cada rango en
 * el momento en que lo pide. Como los nonces son deterministas por índice
 * (ver `e2ee.ts`), volver a cifrar el mismo trozo produce los mismos bytes, así
 * que la REANUDACIÓN funciona sola: tras cerrar el navegador a mitad de subida,
 * la fuente se reconstruye con la misma clave y los rangos vuelven a salir
 * idénticos. El servidor ve un fichero normal de tamaño fijo; el protocolo de
 * partes, los checksums y el estado de reanudación no saben que existe el
 * cifrado.
 *
 * EL LLAVERO LOCAL es la decisión 1 de docs/24: las claves viven en ESTE
 * navegador y en ningún otro sitio. Mientras una subida está en vuelo, la clave
 * cuelga de la huella del fichero (nombre+tamaño+fecha, la misma que usa la
 * reanudación); al completar, pasa a colgar del id del fichero, que es lo que
 * el panel usa para enseñar el nombre de verdad y montar enlaces completos.
 * En otro dispositivo no hay llavero: filas sin nombre, y borrar sigue
 * funcionando porque borrar no necesita clave.
 */

import {
  type CabeceraE2EE,
  ETIQUETA,
  TROZO_CLARO,
  abrirFlujo,
  cifrarCabecera,
  cifrarTrozo,
  claveAFragmento,
  empaquetarPrefijo,
  nuevaClave,
} from "./e2ee";

/** Lo que el transporte necesita de un "fichero": tamaño y rangos de bytes. */
export interface FuenteSubida {
  size: number;
  rango(start: number, end: number): Promise<Uint8Array>;
}

/** El nombre que ve el servidor en lugar del de verdad. Neutro a propósito. */
export const NOMBRE_CIFRADO = "encrypted";
export const TIPO_CIFRADO = "application/octet-stream";

export interface FuenteCifrada extends FuenteSubida {
  /** La mitad del enlace que el servidor nunca ve. */
  fragmento: string;
}

export async function fuenteCifrada(file: File, claveExistente?: Uint8Array): Promise<FuenteCifrada> {
  const clave = claveExistente ?? nuevaClave();
  const cabecera: CabeceraE2EE = {
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
  };
  const prefijo = empaquetarPrefijo(await cifrarCabecera(clave, cabecera), TROZO_CLARO);

  const trozos = Math.max(1, Math.ceil(file.size / TROZO_CLARO));
  const size = prefijo.length + file.size + trozos * ETIQUETA;

  // Los dos últimos trozos cifrados, por índice: la subida va con dos obreros en
  // paralelo y avanza en orden, así que con dos entradas casi nunca se recifra.
  const cache = new Map<number, Uint8Array>();

  async function trozoCifrado(indice: number): Promise<Uint8Array> {
    const guardado = cache.get(indice);
    if (guardado) return guardado;
    const inicio = indice * TROZO_CLARO;
    const claro = new Uint8Array(await file.slice(inicio, Math.min(inicio + TROZO_CLARO, file.size)).arrayBuffer());
    const cifrado = await cifrarTrozo(clave, claro, indice, indice === trozos - 1);
    cache.set(indice, cifrado);
    for (const clave2 of cache.keys()) {
      if (cache.size <= 4) break;
      cache.delete(clave2);
    }
    return cifrado;
  }

  return {
    size,
    fragmento: claveAFragmento(clave),
    async rango(start, end) {
      const fin = Math.min(end, size);
      const salida = new Uint8Array(fin - start);
      let escrito = 0;
      let cursor = start;

      // El trozo del prefijo, si el rango lo pilla.
      if (cursor < prefijo.length) {
        const parte = prefijo.slice(cursor, Math.min(fin, prefijo.length));
        salida.set(parte, escrito);
        escrito += parte.length;
        cursor += parte.length;
      }

      // Y los datos: cada trozo cifrado i ocupa [i·(C+16), …) tras el prefijo.
      const porTrozo = TROZO_CLARO + ETIQUETA;
      while (cursor < fin) {
        const enDatos = cursor - prefijo.length;
        const indice = Math.floor(enDatos / porTrozo);
        const cifrado = await trozoCifrado(indice);
        const desde = enDatos - indice * porTrozo;
        const parte = cifrado.slice(desde, Math.min(desde + (fin - cursor), cifrado.length));
        salida.set(parte, escrito);
        escrito += parte.length;
        cursor += parte.length;
      }
      return salida;
    },
  };
}

// ─── La descarga en flujo, vía service worker ───────────────────────────────

/** iPhone e iPad, con el iPad moderno que se hace pasar por Mac. */
export function esIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/**
 * Navegadores que no convierten en descarga una navegación servida por un
 * service worker: todo WebKit (en iOS lo es hasta Chrome) y los navegadores
 * incrustados en otras apps. Se detectan por el agente de usuario porque no
 * hay otra forma: la API existe en todos y en estos no hace nada, sin error.
 */
export function entornoSinFlujo(): boolean {
  if (typeof navigator === "undefined") return true;
  const ua = navigator.userAgent;
  if (esIOS()) return true;
  const webkit = /AppleWebKit/.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/.test(ua);
  const incrustado = /\bwv\b|FBAN|FBAV|Instagram|Line\/|WhatsApp|Twitter|MicroMessenger|Snapchat/i.test(ua);
  return webkit || incrustado;
}

/**
 * Si este navegador puede descifrar hacia disco sin pasar por la memoria.
 *
 * Tener un service worker no basta, y es lo que se creía: el primer envío
 * real a un iPhone llegó con la clave entera y se quedó en «Decrypting…»
 * porque Safari no convierte la navegación del iframe en una descarga. Ahí se
 * va por memoria, que es lo que docs/24 decía y el código no hacía.
 */
export function descargaEnFlujoDisponible(): boolean {
  return typeof navigator !== "undefined" &&
    Boolean(navigator.serviceWorker?.controller) &&
    !entornoSinFlujo();
}

/**
 * Cómo falló el camino en flujo. `antesDelPrimerByte` es lo que decide si se
 * puede reintentar en memoria sin riesgo: no ha nacido ninguna descarga.
 */
export class FalloFlujo extends Error {
  constructor(message: string, public readonly antesDelPrimerByte: boolean, public readonly estado?: number) {
    super(message);
  }
}

/** El worker tiene que contestar; si no lo hace, la página no espera para siempre. */
const ESPERA_WORKER = 8_000;

/**
 * Descifra un bulto de cualquier tamaño directamente hacia el disco.
 *
 * El truco es convertir un stream de la página en una descarga nativa: se
 * anuncia al service worker una URL de un solo uso con el nombre y el tamaño en
 * claro, un iframe oculto la navega —el navegador arranca su descarga, con su
 * barra de progreso— y el worker TIRA de esta página trozo a trozo ({pide} →
 * {bytes}), que es la contrapresión: nunca hay más de un trozo descifrado en
 * vuelo, dé igual lo rápida que sea la red o lo lento que sea el disco.
 *
 * La cabecera se verifica antes de arrancar nada: un enlace con la clave mal no
 * llega a crear ninguna descarga. Un trozo manipulado a mitad corta el stream y
 * el navegador marca la descarga como fallida — nunca queda un fichero a medias
 * con pinta de entero.
 */
export async function descargarEnFlujo(
  id: string,
  clave: Uint8Array,
  onProgress?: (bytes: number, total: number) => void
): Promise<{ nombre: string }> {
  const controlador = navigator.serviceWorker?.controller;
  if (!controlador) throw new FalloFlujo("no service worker", true);

  const res = await fetch(`/api/download/${id}`);
  if (!res.ok || !res.body) throw new FalloFlujo(`download ${res.status}`, true, res.status);
  const abierto = await abrirFlujo(clave, res.body);
  if (!abierto) throw new FalloFlujo("formato", true);
  const { cabecera, datos } = abierto;

  const token = globalThis.crypto.randomUUID();
  const canal = new MessageChannel();

  const lector = datos.getReader();
  let servido = 0;
  let terminar: (v: { nombre: string }) => void;
  let fallar: (e: unknown) => void;
  const hecho = new Promise<{ nombre: string }>((res2, rej2) => {
    terminar = res2;
    fallar = rej2;
  });

  // Dos plazos: que el worker diga «listo», y que el navegador empiece a
  // tirar. Si cualquiera vence antes del primer byte, el bulto sigue intacto
  // en la respuesta y la página puede descifrarlo en memoria.
  let plazo = setTimeout(() => {
    void lector.cancel().catch(() => {});
    fallar(new FalloFlujo("sw-timeout", servido === 0));
  }, ESPERA_WORKER);

  canal.port1.onmessage = async (event) => {
    const m = event.data as { tipo: string };
    if (m.tipo === "listo") {
      // El worker ya conoce el token: ahora sí puede nacer la descarga.
      const iframe = document.createElement("iframe");
      iframe.hidden = true;
      iframe.src = `/descarga-local/${token}`;
      document.body.appendChild(iframe);
      setTimeout(() => iframe.remove(), 60_000);
      clearTimeout(plazo);
      plazo = setTimeout(() => {
        void lector.cancel().catch(() => {});
        fallar(new FalloFlujo("sw-timeout", servido === 0));
      }, ESPERA_WORKER);
      return;
    }
    if (m.tipo === "pide") {
      clearTimeout(plazo);
      try {
        const { value, done } = await lector.read();
        if (done) {
          canal.port1.postMessage({ tipo: "fin" });
          terminar({ nombre: cabecera.name });
          return;
        }
        servido += value.length;
        onProgress?.(servido, cabecera.size);
        // Transferido, no copiado: el trozo cambia de manos sin duplicarse.
        canal.port1.postMessage({ tipo: "bytes", bytes: value.buffer }, [value.buffer]);
      } catch (error) {
        canal.port1.postMessage({ tipo: "error", motivo: "decrypt failed" });
        fallar(new FalloFlujo(error instanceof Error ? error.message : "decrypt failed", servido === 0));
      }
      return;
    }
    if (m.tipo === "cancelado") {
      clearTimeout(plazo);
      void lector.cancel().catch(() => {});
      fallar(new Error("cancelled"));
    }
  };

  controlador.postMessage(
    { tipo: "docdrop-descarga", token, nombre: cabecera.name, tamano: cabecera.size },
    [canal.port2]
  );

  return hecho;
}

// ─── El llavero local ───────────────────────────────────────────────────────

const EN_VUELO = "docdrop:e2ee:pendiente:";
const POR_ID = "docdrop:e2ee:clave:";

export interface EntradaLlavero {
  /** El fragmento del enlace, sin `#`. */
  k: string;
  /** El nombre de verdad, para que el panel pueda enseñarlo. */
  name: string;
}

/** La misma huella que usa la reanudación del transporte. */
export function huella(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function claveEnVuelo(file: File): Uint8Array | null {
  try {
    const guardada = localStorage.getItem(EN_VUELO + huella(file));
    if (!guardada) return null;
    const bytes = atob(guardada.replaceAll("-", "+").replaceAll("_", "/"));
    const clave = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) clave[i] = bytes.charCodeAt(i);
    return clave.length === 32 ? clave : null;
  } catch {
    return null;
  }
}

export function apuntarClaveEnVuelo(file: File, fragmento: string): void {
  try {
    localStorage.setItem(EN_VUELO + huella(file), fragmento);
  } catch {
    // Modo privado: se pierde la reanudación cifrada, no la subida en curso.
  }
}

/** Al completar: la clave pasa de la huella del fichero al id del servidor. */
export function consolidarClave(file: File, id: string, fragmento: string): void {
  try {
    localStorage.setItem(POR_ID + id, JSON.stringify({ k: fragmento, name: file.name } satisfies EntradaLlavero));
    localStorage.removeItem(EN_VUELO + huella(file));
  } catch {
    /* ignorado */
  }
}

export function entradaLlavero(id: string): EntradaLlavero | null {
  try {
    const cruda = localStorage.getItem(POR_ID + id);
    if (!cruda) return null;
    const entrada = JSON.parse(cruda) as EntradaLlavero;
    return typeof entrada.k === "string" && typeof entrada.name === "string" ? entrada : null;
  } catch {
    return null;
  }
}

export function olvidarClave(id: string): void {
  try {
    localStorage.removeItem(POR_ID + id);
  } catch {
    /* ignorado */
  }
}
