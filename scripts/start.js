#!/usr/bin/env node
/**
 * Arranque de producción con los tiempos de espera ajustados para subidas largas.
 *
 * EL PROBLEMA: Node aborta toda petición que dure más de `server.requestTimeout`,
 * 300 000 ms (5 min) por defecto. Una subida grande es UNA sola petición HTTP, así
 * que a ~19 MB/s el corte llega sobre los 5,6 GB — un fichero de 7 GB muere pasado
 * el 80 % sin ningún error claro en el cliente. Next solo permite configurar
 * `keepAliveTimeout`, no `requestTimeout`, y `output: standalone` es incompatible
 * con un servidor propio (lo dice la documentación), así que se ajusta el valor
 * interceptando la creación del servidor HTTP antes de arrancar Next.
 *
 * Se conserva `headersTimeout` en 60 s: es el que protege de clientes que envían
 * las cabeceras gota a gota. El cuerpo lento no puede crecer sin límite porque
 * /api/upload corta en cuanto se supera el tamaño máximo.
 */
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const fs = require("node:fs");

const HOURS = 60 * 60 * 1000;
const REQUEST_TIMEOUT = Number(process.env.DOCDROP_REQUEST_TIMEOUT_MS) || 12 * HOURS;
const HEADERS_TIMEOUT = Number(process.env.DOCDROP_HEADERS_TIMEOUT_MS) || 60_000;

let patched = 0;

function patchFactory(module, name) {
  const original = module[name];
  module[name] = function (...args) {
    const server = original.apply(this, args);
    server.requestTimeout = REQUEST_TIMEOUT;
    server.headersTimeout = HEADERS_TIMEOUT;
    patched += 1;
    return server;
  };
}

patchFactory(http, "createServer");
patchFactory(https, "createServer");

// El servidor de standalone hace chdir a su propio directorio, así que la ruta de
// datos por defecto (relativa al cwd) dejaría de apuntar al proyecto. Se fija aquí,
// antes de cederle el control. En producción systemd ya define DOCDROP_DATA_DIR.
if (!process.env.DOCDROP_DATA_DIR) {
  process.env.DOCDROP_DATA_DIR = path.join(process.cwd(), ".docdrop-uploads");
}

// El server.js de standalone está junto a este fichero cuando se despliega, y en
// .next/standalone cuando se ejecuta desde el repositorio.
const candidates = [
  path.join(__dirname, "server.js"),
  path.join(__dirname, "..", "server.js"),
  path.join(__dirname, "..", ".next", "standalone", "server.js"),
];

const target = candidates.find((candidate) => fs.existsSync(candidate));
if (!target) {
  console.error(
    "[docdrop] No encuentro el servidor de Next. Ejecuta 'npm run build' antes de arrancar."
  );
  process.exit(1);
}

const minutes = Math.round(REQUEST_TIMEOUT / 60000);
console.log(`[docdrop] límite por petición: ${minutes} min (subidas largas permitidas)`);

require(target);

// Si una versión futura de Next dejara de usar http.createServer, el ajuste no se
// aplicaría y volverían los cortes a los 5 minutos. Mejor enterarse por el log que
// por una subida de 7 GB que se rompe al 80 %.
setTimeout(() => {
  if (patched === 0) {
    console.error(
      "[docdrop] AVISO: no se pudo ajustar requestTimeout; las subidas de más de " +
        "5 minutos se cortarán. Revisa scripts/start.js."
    );
  }
}, 5000).unref();
