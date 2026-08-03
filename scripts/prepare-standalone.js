#!/usr/bin/env node
/**
 * Completa la salida standalone tras el build.
 *
 * `next build` deja en .next/standalone el servidor y sus dependencias, pero NO los
 * ficheros estáticos: hay que copiar .next/static y public a mano o la aplicación
 * arranca sin estilos ni JavaScript. Se ejecuta como postbuild.
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const standalone = path.join(root, ".next", "standalone");

if (!fs.existsSync(standalone)) {
  console.error("[docdrop] No hay salida standalone; ¿falta 'output: standalone' en next.config?");
  process.exit(1);
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) return false;
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
  return true;
}

copyDir(path.join(root, ".next", "static"), path.join(standalone, ".next", "static"));
copyDir(path.join(root, "public"), path.join(standalone, "public"));

// El lanzador con los tiempos de espera ajustados viaja junto al servidor, para que
// el despliegue solo tenga que copiar este directorio.
fs.copyFileSync(path.join(__dirname, "start.js"), path.join(standalone, "start.js"));

console.log("[docdrop] standalone listo (estáticos + lanzador)");
