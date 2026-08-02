/**
 * Se ejecuta una vez al arrancar el servidor.
 *
 * Deja constancia en el log de en qué modo ha arrancado. El objetivo es que "está
 * abierto sin contraseña" sea siempre una decisión visible y no algo que pase
 * inadvertido porque el fichero de entorno se perdió en un despliegue.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { authRequired } = await import("@/lib/auth");
  const { MAX_TOTAL_BYTES, UPLOAD_DIR } = await import("@/lib/store");

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
}
