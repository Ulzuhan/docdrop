/**
 * La lista de revocación: quién dejó de tener acceso, y desde cuándo.
 *
 * POR QUÉ EXISTE. La sesión de esta aplicación es una cookie firmada sin nada
 * en el servidor, y eso tiene una consecuencia incómoda: cuando el proveedor
 * avisa de que alguien ha dejado de tener acceso, **no hay ninguna sesión que
 * borrar**. La cookie ya está en su navegador y sigue siendo válida hasta que
 * caduque sola.
 *
 * La respuesta estándar a eso no es guardar sesiones —volveríamos a tener
 * estado por cada visita— sino guardar lo contrario: una marca por persona que
 * dice «lo emitido antes de este instante ya no vale». Es una línea por
 * revocación, se borra sola, y deja intacto el diseño sin estado para todo el
 * mundo que no ha sido revocado.
 *
 * ASÍ LAS CINCO HERRAMIENTAS SE COMPORTAN IGUAL. Las que guardan la sesión en
 * base de datos la borran; las que no, apuntan aquí. Lo que ve quien usa esto
 * es lo mismo en las cinco: quitar el acceso surte efecto en la siguiente
 * petición. Que el mecanismo por dentro difiera es un detalle de cómo guarda
 * cada una, no del trato.
 *
 * LO QUE GUARDA, y conviene que sea poco: un identificador opaco y una fecha.
 * Ni correo, ni nombre, ni nada de lo que la persona haya subido. Y se poda:
 * pasada la vida máxima de una sesión, la marca ya no puede impedir nada
 * porque la cookie a la que se refería habría caducado igual.
 *
 * Se lee y se escribe de forma SÍNCRONA a propósito: el fichero tiene unas
 * pocas líneas, se carga una vez al arrancar y a partir de ahí vive en memoria.
 * Hacerlo asíncrono obligaría a volver `readToken` asíncrono y a tocar todas
 * las rutas para no ganar nada.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { UPLOAD_DIR } from "@/lib/store";

/** Cuánto se conserva una marca. Ver la cabecera: más allá no puede impedir nada. */
const VIDA_MS = 25 * 60 * 60 * 1000;

function archivo(): string {
  return join(UPLOAD_DIR, "revocaciones.json");
}

let memoria: Map<string, number> | null = null;

function podar(mapa: Map<string, number>): Map<string, number> {
  const limite = Date.now() - VIDA_MS;
  for (const [clave, cuando] of mapa) if (cuando < limite) mapa.delete(clave);
  return mapa;
}

function cargar(): Map<string, number> {
  if (memoria) return memoria;
  try {
    const crudo = JSON.parse(readFileSync(archivo(), "utf8")) as Record<string, number>;
    memoria = podar(new Map(Object.entries(crudo).filter(([, v]) => typeof v === "number")));
  } catch {
    // Sin fichero todavía, o ilegible: se empieza vacío. No poder LEER la lista
    // no debe tumbar la aplicación; lo que no puede fallar en silencio es
    // escribirla, y de eso se encarga `revocar`.
    memoria = new Map();
  }
  return memoria;
}

/** Solo para las pruebas: olvida lo cargado y vuelve a leer del disco. */
export function olvidarRevocaciones(): void {
  memoria = null;
}

/**
 * Marca que todo lo emitido para esta persona hasta ahora deja de valer.
 *
 * Lanza si no puede escribir: quien llama (el aviso del proveedor) tiene que
 * poder responder que no se ha atendido, para que lo reintente. Una revocación
 * que se pierde en silencio es peor que no tener revocación.
 */
export function revocar(identificador: string): void {
  const mapa = podar(cargar());
  mapa.set(identificador, Date.now());

  const destino = archivo();
  mkdirSync(dirname(destino), { recursive: true });
  // Escritura atómica: un fichero a medias por un corte dejaría la lista
  // ilegible, y una lista ilegible se lee como «no hay revocaciones».
  const temporal = `${destino}.${process.pid}.tmp`;
  writeFileSync(temporal, JSON.stringify(Object.fromEntries(mapa)), { mode: 0o600 });
  renameSync(temporal, destino);
}

/** ¿Estaba revocada esta persona cuando se emitió esa sesión? */
export function revocadaDespuesDe(identificador: string, emitidaEn: number): boolean {
  const cuando = cargar().get(identificador);
  return cuando !== undefined && emitidaEn <= cuando;
}
