import { NextRequest, NextResponse } from "next/server";
import { createWriteStream } from "fs";
import { stat } from "fs/promises";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "stream/web";
import {
  MAX_FILE_SIZE,
  MAX_TOTAL_BYTES,
  blobPath,
  clampMaxDownloads,
  clampTtlHours,
  createEntryDir,
  deleteEntry,
  generateId,
  sanitizeFilename,
  sanitizeUploader,
  usedBytes,
  writeMeta,
  type FileMeta,
} from "@/lib/store";
import { requireSession } from "@/lib/auth";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/ratelimit";

/**
 * POST /api/upload — el cuerpo de la petición ES el fichero (no multipart).
 *
 * Metadatos por cabecera:
 *   x-filename       nombre original, percent-encoded (UTF-8)
 *   x-ttl-hours      horas hasta la autodestrucción (1..720)
 *   x-max-downloads  0 = ilimitado
 *
 * Antes esto usaba request.formData(), que materializa el fichero entero en memoria:
 * con el límite anunciado de 10 GB el proceso moría mucho antes de llegar (el tope de
 * Buffer en Node ronda los 2 GB). Ahora el cuerpo se canaliza a disco por streaming, así
 * que la memoria usada es constante e independiente del tamaño del fichero.
 */
export async function POST(request: NextRequest) {
  // Subir exige sesión: expuesto a internet, un endpoint de subida abierto es
  // alojamiento anónimo gratis y una forma trivial de llenar el disco.
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

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

  const ttlHours = clampTtlHours(request.headers.get("x-ttl-hours"));
  const maxDownloads = clampMaxDownloads(request.headers.get("x-max-downloads"));

  // Rechazo temprano si el cliente ya declara un tamaño excesivo, para no escribir
  // gigabytes en disco antes de darnos cuenta.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_FILE_SIZE) {
    return NextResponse.json({ error: "File too large. Max 10GB." }, { status: 413 });
  }

  // Cuota global: impide que el almacén crezca hasta llenar el disco de la máquina,
  // que se llevaría por delante al resto de servicios del equipo.
  const used = await usedBytes();
  const budget = MAX_TOTAL_BYTES - used;
  if (budget <= 0) {
    return NextResponse.json(
      { error: "Storage full. Delete or wait for files to expire." },
      { status: 507 }
    );
  }
  if (Number.isFinite(declared) && declared > budget) {
    return NextResponse.json(
      { error: "Not enough storage left for this file." },
      { status: 507 }
    );
  }

  // El corte real se hace sobre lo que llegue de verdad, no sobre lo declarado.
  const hardCap = Math.min(MAX_FILE_SIZE, budget);

  const id = generateId();

  try {
    await createEntryDir(id);

    // Corta la subida en cuanto se pasa del límite, aunque el cliente haya mentido en
    // Content-Length o no lo haya enviado.
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

    // El tamaño se toma del disco, no de lo que dijera el cliente.
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
      uploadedBy: sanitizeUploader(
        request.headers.get("x-uploaded-by")
          ? decodeURIComponent(request.headers.get("x-uploaded-by")!)
          : undefined
      ),
    };
    await writeMeta(meta);

    return NextResponse.json({
      id,
      originalName: meta.originalName,
      size: meta.size,
      expiresAt: meta.expiresAt,
      maxDownloads: meta.maxDownloads,
      downloadUrl: `/d/${id}`,
    });
  } catch (error) {
    // Sin esto, una subida interrumpida dejaba el directorio a medias para siempre.
    await deleteEntry(id).catch(() => {});

    if ((error as { code?: string }).code === "TOO_LARGE") {
      return NextResponse.json({ error: "File too large. Max 10GB." }, { status: 413 });
    }
    console.error("Upload error:", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
