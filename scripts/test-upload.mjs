#!/usr/bin/env node
/**
 * Integration tests for the upload protocol.
 *
 * This is the trickiest part of the service (resuming, idempotency, limits,
 * integrity) and it is worth having covered. Runs against an already running server,
 * with no dependencies and no test framework:
 *
 *   npm run start &
 *   npm run test:upload            # or: BASE=https://... node scripts/test-upload.mjs
 *
 * It deletes nothing it did not create: every test file is uploaded with the minimum
 * TTL and removed at the end.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 3010}`;

/**
 * Subir exige sesión desde que la identidad se mudó a Authentik, así que la
 * suite necesita una. No se abre ninguna puerta para las pruebas: se hacen las
 * dos cosas que hace la aplicación al entrar alguien — escribir su ficha de
 * usuario y firmarle la cookie— con el mismo formato y el mismo secreto
 * (`src/lib/auth.ts` y `src/lib/users.ts`).
 *
 * Sin `DOCDROP_SESSION_SECRET` no se puede firmar nada, y la suite lo dice en
 * vez de estrellarse contra un 401 sin explicación.
 */
const TEST_SUB = "test-suite";
const TEST_UID = "u_test_suite";

async function seedUser() {
  // Misma ruta y mismo nombre de fichero que `users.ts`: el sub, hasheado.
  const dir = join(process.env.DOCDROP_DATA_DIR || ".docdrop-uploads", "users");
  await mkdir(dir, { recursive: true });
  const nombre = createHash("sha256").update(TEST_SUB).digest("hex");
  const ahora = Date.now();
  await writeFile(
    join(dir, `${nombre}.json`),
    JSON.stringify(
      { id: TEST_UID, oidcSub: TEST_SUB, email: "suite@example.invalid",
        name: "Upload suite", createdAt: ahora, lastSeenAt: ahora },
      null, 2
    )
  );
}

function sessionCookie() {
  const secret = process.env.DOCDROP_SESSION_SECRET;
  if (!secret) return null;
  const payload = Buffer.from(
    JSON.stringify({ uid: TEST_UID, exp: Date.now() + 3_600_000 })
  ).toString("base64url");
  const firma = createHmac("sha256", secret).update(payload).digest("base64url");
  return `docdrop_session=${payload}.${firma}`;
}

// Se envuelve `fetch` en vez de tocar las once llamadas: la cookie es un
// detalle del transporte y no de lo que cada prueba comprueba.
const COOKIE = sessionCookie();
const sinCookie = globalThis.fetch;
globalThis.fetch = (url, init = {}) =>
  sinCookie(url, COOKIE ? { ...init, headers: { ...(init.headers ?? {}), cookie: COOKIE } } : init);

let passed = 0;
let failed = 0;
const created = [];

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
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
  console.log(`Testing against ${BASE}\n`);

  // Se sondea la portada y no `/api/files`: ese listado enumera TODOS los
  // enlaces activos, así que desde que la identidad vive en Authentik exige
  // sesión y devuelve 401. El sondeo daba entonces "no hay servidor" con el
  // servidor perfectamente levantado. Las rutas que esta suite ejercita
  // (`/api/upload/*`) siguen sin pedir sesión, que es lo que se está probando.
  const health = await fetch(`${BASE}/`).catch(() => null);
  if (!health?.ok) {
    console.error(`No server at ${BASE}. Start one with: npm run start`);
    process.exit(1);
  }
  await seedUser();
  if (!COOKIE) {
    console.error(
      "Sin DOCDROP_SESSION_SECRET no se puede firmar una sesión, y subir la exige.\n" +
      "Arranca el servidor y la suite con el mismo valor:\n" +
      "  DOCDROP_SESSION_SECRET=cualquier-cosa npm run start &\n" +
      "  DOCDROP_SESSION_SECRET=cualquier-cosa npm run test:upload"
    );
    process.exit(1);
  }

  // ── Full upload in several chunks ─────────────────────────────────
  console.log("Chunked upload");
  const { body: session } = await initUpload(0).then(() => initUpload(200_000));
  const { uploadId, chunkSize, totalParts } = session;
  created.push(uploadId);
  check("init returns an uploadId", typeof uploadId === "string" && uploadId.length > 0, true);

  const payload = randomBytes(200_000);
  for (let i = 0; i < totalParts; i++) {
    const chunk = payload.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, payload.length));
    const res = await putPart(uploadId, i, chunk, { "X-Chunk-Sha256": sha256(chunk) });
    if (i === 0) check("chunk with a correct checksum", res.status, 200);
  }

  const done = await fetch(`${BASE}/api/upload/${uploadId}/complete`, { method: "POST" });
  const result = await done.json();
  check("complete returns 200", done.status, 200);
  check("correct size", result.size, payload.length);

  const back = Buffer.from(await (await fetch(`${BASE}/api/download/${result.id}`)).arrayBuffer());
  check("identical content", sha256(back), sha256(payload));

  // ── Resuming ──────────────────────────────────────────────────────
  // The file must span SEVERAL chunks or there is nothing to resume: with a single
  // one, the first PUT already completes the upload.
  console.log("\nResuming");
  const big = randomBytes(Math.floor(chunkSize * 2.5));
  const { body: s2 } = await initUpload(big.length);
  created.push(s2.uploadId);

  const firstChunk = big.subarray(0, Math.min(s2.chunkSize, big.length));
  await putPart(s2.uploadId, 0, firstChunk, { "X-Chunk-Sha256": sha256(firstChunk) });

  check("the test file spans several chunks", s2.totalParts > 1, true);

  const state = await (await fetch(`${BASE}/api/upload/${s2.uploadId}`)).json();
  check("reports the received chunks", state.received, [0]);
  check("knows it is not complete", state.complete, false);

  const early = await fetch(`${BASE}/api/upload/${s2.uploadId}/complete`, { method: "POST" });
  check("refuses to close with chunks pending", early.status, 409);
  const earlyBody = await early.json();
  check("and says which ones are missing", earlyBody.missing.length, s2.totalParts - 1);

  // ── Idempotency ───────────────────────────────────────────────────
  console.log("\nIdempotency and validation");
  const again = await putPart(s2.uploadId, 0, firstChunk, { "X-Chunk-Sha256": sha256(firstChunk) });
  const againBody = await again.json();
  check("re-sending an already received chunk does not fail", again.status, 200);
  check("and says so", againBody.alreadyReceived, true);

  // ── Integrity ─────────────────────────────────────────────────────
  const { body: s3 } = await initUpload(1000);
  created.push(s3.uploadId);
  const good = randomBytes(1000);
  const badHash = await putPart(s3.uploadId, 0, good, { "X-Chunk-Sha256": sha256(randomBytes(8)) });
  check("mismatched checksum -> 422", badHash.status, 422);

  const stillMissing = await (await fetch(`${BASE}/api/upload/${s3.uploadId}`)).json();
  check("and the chunk is NOT marked as received", stillMissing.received, []);

  const fixed = await putPart(s3.uploadId, 0, good, { "X-Chunk-Sha256": sha256(good) });
  check("re-sending it correctly is accepted", fixed.status, 200);

  // ── Expected errors ───────────────────────────────────────────────
  const badIndex = await putPart(s3.uploadId, 999, good);
  check("out-of-range index -> 400", badIndex.status, 400);

  const missing = await fetch(`${BASE}/api/upload/000000000000/`, { method: "GET" });
  check("unknown session -> 404", missing.status, 404);

  const tooBig = await initUpload(Number.MAX_SAFE_INTEGER);
  check("impossible size -> 413 or 507", [413, 507].includes(tooBig.status), true);

  // ── Cleanup ───────────────────────────────────────────────────────
  console.log("\nCleaning up what the test created");
  for (const id of created) {
    await fetch(`${BASE}/api/upload/${id}`, { method: "DELETE" }).catch(() => {});
  }
  if (result?.id) await fetch(`${BASE}/api/files/${result.id}`, { method: "DELETE" }).catch(() => {});

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("The test itself broke:", error);
  process.exit(1);
});
