/**
 * Arranque del servidor (solo Node). Ver `instrumentation.ts` para saber por qué
 * está en un fichero aparte.
 *
 * Hace dos cosas: dejar constancia en el log de en qué modo ha arrancado, y poner en
 * marcha el barrido periódico del almacén.
 */
import { authRequired } from "@/lib/auth";
import { MAX_TOTAL_BYTES, UPLOAD_DIR, cleanup } from "@/lib/store";
import { cleanupSessions } from "@/lib/upload-session";

/** Cada cuánto se purga lo caducado. */
const SWEEP_INTERVAL = 60 * 60 * 1000;

const gib = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GiB`;

if (authRequired()) {
  console.log("[docdrop] modo: PROTEGIDO — subir y listar exigen contraseña");
} else {
  console.warn(
    "[docdrop] modo: ABIERTO — cualquiera que llegue al servicio puede subir " +
      "ficheros y ver la lista completa. Adecuado en red privada o tras un túnel " +
      "temporal; para protegerlo: npm run set-password"
  );
}
console.log(`[docdrop] datos en ${UPLOAD_DIR} · cuota ${gib(MAX_TOTAL_BYTES)}`);

/**
 * Barrido periódico.
 *
 * Sin esto, un fichero caducado solo se borraba cuando alguien intentaba abrirlo: un
 * vídeo de varios GB que caduca y nadie vuelve a tocar se quedaba ocupando la cuota
 * para siempre, hasta que las subidas nuevas empezaban a fallar con "Storage full"
 * sin que nada estuviera realmente en uso.
 */
async function sweep() {
  try {
    const abandoned = await cleanupSessions();
    const deleted = await cleanup();
    if (deleted.length + abandoned.length > 0) {
      console.log(
        `[docdrop] barrido: ${deleted.length} caducados, ` +
          `${abandoned.length} subidas abandonadas`
      );
    }
  } catch (error) {
    console.error("[docdrop] fallo en el barrido:", error);
  }
}

void sweep();
// unref() para que el temporizador no impida al proceso terminar cuando toque.
setInterval(sweep, SWEEP_INTERVAL).unref();
console.log(`[docdrop] barrido automático cada ${SWEEP_INTERVAL / 60000} min`);
