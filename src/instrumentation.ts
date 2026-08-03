/**
 * Next llama a `register` en TODOS los entornos, incluido el Edge Runtime, donde no
 * existen `fs` ni `process.cwd()`. Por eso el arranque real vive en un fichero aparte
 * que solo se importa bajo Node: si se importara desde aquí, aunque fuese dentro de
 * un `if`, el empaquetador lo seguiría metiendo en el bundle de Edge y la compilación
 * fallaría. Es el patrón que documenta Next.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
