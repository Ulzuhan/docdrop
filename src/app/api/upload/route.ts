import { NextRequest, NextResponse } from "next/server";
import { createWriteStream } from "fs";
import { stat } from "fs/promises";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "stream/web";
import {
  MAX_FILE_SIZE,
  blobPath,
  clampMaxDownloads,
  clampTtlHours,
  createEntryDir,
  deleteEntry,
  generateId,
  sanitizeFilename,
  reservarEspacio,
  soltarEspacio,
  writeMeta,
  type FileMeta,
} from "@/lib/store";
import {
  MAX_GUEST_FILE_TTL_HOURS,
  guestFromRequest,
  recordGuestUpload,
  requireUploadAccess,
  ownerForGuestToken,
} from "@/lib/guest";
import { currentUser } from "@/lib/auth";
import { displayName } from "@/lib/users";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/ratelimit";
import { isSameOriginMutation } from "@/lib/request-origin";

/**
 * POST /api/upload — the request body IS the file (not multipart).
 *
 * Metadata travels in headers:
 *   x-filename       original name, percent-encoded (UTF-8)
 *   x-ttl-hours      hours until self-destruction (1..720)
 *   x-max-downloads  0 = unlimited
 *
 * This used to call request.formData(), which materialises the whole file in memory:
 * with the advertised 10 GB limit the process died long before getting there (Node's
 * Buffer cap is around 2 GB). The body is now streamed to disk, so memory usage is
 * constant and independent of the file size.
 */
export async function POST(request: NextRequest) {
  if (!isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });
  }
  // Uploading requires a session or a live guest link: exposed to the internet, an
  // open upload endpoint is free anonymous hosting and a trivial way to fill the disk.
  const unauthorized = await requireUploadAccess(request);
  if (unauthorized) return unauthorized;

  const guest = await guestFromRequest(request);
  const account = guest ? null : await currentUser();

  const limit = rateLimit(`upload:${clientIp(request)}`, 30, 60 * 60 * 1000);
  if (!limit.allowed) return tooManyRequests(limit);

  if (!request.body) {
    return NextResponse.json({ error: "Empty request body" }, { status: 400 });
  }

  const rawName = request.headers.get("x-filename");
  if (!rawName) {
    return NextResponse.json({ error: "Missing x-filename header" }, { status: 400 });
  }

  let originalName: string;
  try {
    originalName = sanitizeFilename(decodeURIComponent(rawName));
  } catch {
    return NextResponse.json({ error: "Malformed x-filename header" }, { status: 400 });
  }

  // Guests get a shorter ceiling, enforced server-side (see /api/upload/init).
  const ttlHours = guest
    ? Math.min(clampTtlHours(request.headers.get("x-ttl-hours")), MAX_GUEST_FILE_TTL_HOURS)
    : clampTtlHours(request.headers.get("x-ttl-hours"));
  const maxDownloads = clampMaxDownloads(request.headers.get("x-max-downloads"));

  // Early rejection when the client already declares an excessive size, so we do
  // not write gigabytes to disk before noticing.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_FILE_SIZE) {
    return NextResponse.json({ error: "File too large. Max 10GB." }, { status: 413 });
  }

  // Se aparta el sitio bajo el candado y se transmite FUERA de él.
  //
  // Tenerlo puesto durante toda la transferencia cierra la carrera —dos subidas
  // viendo el mismo hueco libre— pero serializa la aplicación entera: medido, una
  // subida de 1 MB tardaba 3,2 segundos esperando a otra que goteaba, y con un
  // fichero de varios gigas desde una casa eso son minutos con todo el mundo
  // parado. En una herramienta que existe para ficheros grandes, eso no vale.
  //
  // Se aparta lo que el cliente declara; si no declara nada, lo que quepa, que es
  // la opción conservadora.
  const reservado = await reservarEspacio((disponible) => {
    if (disponible <= 0) return null;
    if (Number.isFinite(declared) && declared > disponible) return null;
    const tope = Math.min(MAX_FILE_SIZE, disponible);
    return Number.isFinite(declared) && declared > 0 ? Math.min(declared, tope) : tope;
  });

  if (reservado === null) {
    return NextResponse.json(
      { error: "Not enough storage left for this file." },
      { status: 507 }
    );
  }

  try {
  // The real cut-off applies to what actually arrives, not to what was declared.
  const hardCap = reservado;

  const id = generateId();

  try {
    await createEntryDir(id);

    // Aborts as soon as the limit is exceeded, even if the client lied in
    // Content-Length or sent none at all.
    let written = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        written += chunk.length;
        if (written > hardCap) {
          cb(Object.assign(new Error("File too large"), { code: "TOO_LARGE" }));
          return;
        }
        cb(null, chunk);
      },
    });

    const source = Readable.fromWeb(request.body as unknown as NodeWebReadableStream);
    await pipeline(source, limiter, createWriteStream(blobPath(id)));

    if (written === 0) {
      await deleteEntry(id);
      return NextResponse.json({ error: "Empty file" }, { status: 400 });
    }

    // The size comes from disk, not from whatever the client claimed.
    const size = (await stat(blobPath(id))).size;

    const now = Date.now();
    const meta: FileMeta = {
      id,
      originalName,
      size,
      mimeType: request.headers.get("content-type") || "application/octet-stream",
      uploadedAt: now,
      expiresAt: now + ttlHours * 60 * 60 * 1000,
      downloadCount: 0,
      maxDownloads,
      // The account's name, or the guest link's label. Never what the client says.
      uploadedBy: account ? displayName(account) : guest?.label,
      // La credencial, no la etiqueta: lo subido por cuenta es de esa cuenta, y
      // lo subido por un enlace de invitado, de quien emitió el enlace.
      owner: account ? `user:${account.id}` : guest ? await ownerForGuestToken(guest.token) : undefined,
      // Autodeclarado, como en /api/upload/init: solo decide el camino de la
      // página de descarga.
      encrypted: request.headers.get("x-docdrop-encrypted") === "1" || undefined,
    };
    await writeMeta(meta);
    if (guest) await recordGuestUpload(guest.token);

    return NextResponse.json({
      id,
      originalName: meta.originalName,
      size: meta.size,
      expiresAt: meta.expiresAt,
      maxDownloads: meta.maxDownloads,
      downloadUrl: `/d/${id}`,
    });
  } catch (error) {
    // Without this, an interrupted upload left a half-written directory forever.
    await deleteEntry(id).catch(() => {});

    if ((error as { code?: string }).code === "TOO_LARGE") {
      return NextResponse.json({ error: "File too large. Max 10GB." }, { status: 413 });
    }
    console.error("Upload error:", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
  } finally {
    // Pase lo que pase. Si no se suelta, el hueco queda apartado para siempre y la
    // instancia se va quedando sin sitio sola.
    soltarEspacio(reservado);
  }
}
