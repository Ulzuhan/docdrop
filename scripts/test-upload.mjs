#!/usr/bin/env node
/**
 * Pruebas de integración del protocolo de subida.
 *
 * Es la parte con más aristas del servicio (reanudación, idempotencia, límites,
 * integridad) y hasta ahora solo se había verificado a mano. Se ejecuta contra un
 * servidor ya en marcha, sin dependencias ni framework:
 *
 *   PORT=3456 npm run start &
 *   npm run test:upload            # o: BASE=https://... node scripts/test-upload.mjs
 *
 * No borra nada que no haya creado él mismo: todos los ficheros de prueba se suben
 * con el TTL mínimo y se eliminan al terminar.
 */
import { createHash, randomBytes } from "node:crypto";

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 3456}`;

let passed = 0;
let failed = 0;
const created = [];

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `  (esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)})`}`);
  if (ok) passed++;
  else failed++;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function initUpload(size, extra = {}) {
  const res = await fetch(`${BASE}/api/upload/init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: "test.bin", size, ttlHours: 1, ...extra }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function putPart(uploadId, index, chunk, headers = {}) {
  return fetch(`${BASE}/api/upload/${uploadId}/part/${index}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", ...headers },
    body: chunk,
  });
}

async function main() {
  console.log(`Probando contra ${BASE}\n`);

  const health = await fetch(`${BASE}/api/files`).catch(() => null);
  if (!health?.ok) {
    console.error(`No hay servidor en ${BASE}. Arráncalo con: PORT=3456 npm run start`);
    process.exit(1);
  }

  // ── Subida completa en varios trozos ──────────────────────────────
  console.log("Subida por trozos");
  const { body: session } = await initUpload(0).then(() => initUpload(200_000));
  const { uploadId, chunkSize, totalParts } = session;
  created.push(uploadId);
  check("init devuelve uploadId", typeof uploadId === "string" && uploadId.length > 0, true);

  const payload = randomBytes(200_000);
  for (let i = 0; i < totalParts; i++) {
    const chunk = payload.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, payload.length));
    const res = await putPart(uploadId, i, chunk, { "X-Chunk-Sha256": sha256(chunk) });
    if (i === 0) check("trozo con checksum correcto", res.status, 200);
  }

  const done = await fetch(`${BASE}/api/upload/${uploadId}/complete`, { method: "POST" });
  const result = await done.json();
  check("complete devuelve 200", done.status, 200);
  check("tamaño correcto", result.size, payload.length);

  const back = Buffer.from(await (await fetch(`${BASE}/api/download/${result.id}`)).arrayBuffer());
  check("contenido idéntico", sha256(back), sha256(payload));

  // ── Reanudación ───────────────────────────────────────────────────
  // El fichero debe ocupar VARIOS trozos o no hay nada que reanudar: con uno solo,
  // el primer PUT ya deja la subida completa.
  console.log("\nReanudación");
  const big = randomBytes(Math.floor(chunkSize * 2.5));
  const { body: s2 } = await initUpload(big.length);
  created.push(s2.uploadId);

  const firstChunk = big.subarray(0, Math.min(s2.chunkSize, big.length));
  await putPart(s2.uploadId, 0, firstChunk, { "X-Chunk-Sha256": sha256(firstChunk) });

  check("el fichero de prueba ocupa varios trozos", s2.totalParts > 1, true);

  const state = await (await fetch(`${BASE}/api/upload/${s2.uploadId}`)).json();
  check("informa de los trozos recibidos", state.received, [0]);
  check("sabe que no está completa", state.complete, false);

  const early = await fetch(`${BASE}/api/upload/${s2.uploadId}/complete`, { method: "POST" });
  check("no cierra con trozos pendientes", early.status, 409);
  const earlyBody = await early.json();
  check("y dice cuáles faltan", earlyBody.missing.length, s2.totalParts - 1);

  // ── Idempotencia ──────────────────────────────────────────────────
  console.log("\nIdempotencia y validación");
  const again = await putPart(s2.uploadId, 0, firstChunk, { "X-Chunk-Sha256": sha256(firstChunk) });
  const againBody = await again.json();
  check("reenviar un trozo ya recibido no falla", again.status, 200);
  check("y lo indica", againBody.alreadyReceived, true);

  // ── Integridad ────────────────────────────────────────────────────
  const { body: s3 } = await initUpload(1000);
  created.push(s3.uploadId);
  const good = randomBytes(1000);
  const badHash = await putPart(s3.uploadId, 0, good, { "X-Chunk-Sha256": sha256(randomBytes(8)) });
  check("checksum que no cuadra -> 422", badHash.status, 422);

  const stillMissing = await (await fetch(`${BASE}/api/upload/${s3.uploadId}`)).json();
  check("y el trozo NO se da por recibido", stillMissing.received, []);

  const fixed = await putPart(s3.uploadId, 0, good, { "X-Chunk-Sha256": sha256(good) });
  check("reenviarlo bien lo acepta", fixed.status, 200);

  // ── Errores esperados ─────────────────────────────────────────────
  const badIndex = await putPart(s3.uploadId, 999, good);
  check("índice fuera de rango -> 400", badIndex.status, 400);

  const missing = await fetch(`${BASE}/api/upload/000000000000/`, { method: "GET" });
  check("sesión inexistente -> 404", missing.status, 404);

  const tooBig = await initUpload(Number.MAX_SAFE_INTEGER);
  check("tamaño imposible -> 413 o 507", [413, 507].includes(tooBig.status), true);

  // ── Limpieza ──────────────────────────────────────────────────────
  console.log("\nLimpiando lo creado por la prueba");
  for (const id of created) {
    await fetch(`${BASE}/api/upload/${id}`, { method: "DELETE" }).catch(() => {});
  }
  if (result?.id) await fetch(`${BASE}/api/files/${result.id}`, { method: "DELETE" }).catch(() => {});

  console.log(`\n${passed} correctas, ${failed} fallidas`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("La prueba se rompió:", error);
  process.exit(1);
});
