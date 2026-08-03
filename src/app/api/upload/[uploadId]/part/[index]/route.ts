import { NextRequest, NextResponse } from "next/server";
import { createWriteStream } from "fs";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "stream/web";
import { blobPath } from "@/lib/store";
import {
  isPartReceived,
  markPartReceived,
  partRange,
  partSize,
  readSession,
} from "@/lib/upload-session";
import { requireSession } from "@/lib/auth";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/ratelimit";

/**
 * PUT /api/upload/[uploadId]/part/[index] — recibe un trozo.
 *
 * El cuerpo es el trozo en crudo y se escribe directamente en su posición dentro del
 * fichero final, así que no hace falta ensamblar nada después.
 *
 * Es idempotente: reenviar un trozo ya recibido responde 200 sin volver a escribirlo,
 * que es lo que permite reintentar sin miedo cuando la red falla a mitad.
 */
export async function PUT(
  request: NextRequest,
  ctx: RouteContext<"/api/upload/[uploadId]/part/[index]">
) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  // Cupo amplio: una subida grande son cientos de trozos legítimos.
  const limit = rateLimit(`upload-part:${clientIp(request)}`, 5000, 60 * 60 * 1000);
  if (!limit.allowed) return tooManyRequests(limit);

  const { uploadId, index: rawIndex } = await ctx.params;

  const session = await readSession(uploadId);
  if (!session) {
    return NextResponse.json({ error: "Upload session not found" }, { status: 404 });
  }
  if (session.sessionExpiresAt < Date.now()) {
    return NextResponse.json({ error: "Upload session expired" }, { status: 410 });
  }

  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 0 || index >= session.totalParts) {
    return NextResponse.json({ error: "Invalid part index" }, { status: 400 });
  }

  if (await isPartReceived(uploadId, index)) {
    return NextResponse.json({ ok: true, index, alreadyReceived: true });
  }

  if (!request.body) {
    return NextResponse.json({ error: "Empty body" }, { status: 400 });
  }

  const expected = partSize(session, index);
  const { start } = partRange(session, index);

  let written = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      if (written > expected) {
        cb(Object.assign(new Error("Part larger than expected"), { code: "PART_TOO_LARGE" }));
        return;
      }
      cb(null, chunk);
    },
  });

  try {
    const source = Readable.fromWeb(request.body as unknown as NodeWebReadableStream);
    // 'r+' abre sin truncar y `start` sitúa la escritura en el offset del trozo.
    await pipeline(source, counter, createWriteStream(blobPath(uploadId), { flags: "r+", start }));
  } catch (error) {
    if ((error as { code?: string }).code === "PART_TOO_LARGE") {
      return NextResponse.json({ error: "Part larger than expected" }, { status: 413 });
    }
    console.error("Part upload error:", error);
    return NextResponse.json({ error: "Part upload failed" }, { status: 500 });
  }

  // Un trozo corto significa que la conexión se cortó a medias: no se marca como
  // recibido, así que el cliente lo reintentará y se sobrescribirá el mismo rango.
  if (written !== expected) {
    return NextResponse.json(
      { error: "Incomplete part", expected, received: written },
      { status: 400 }
    );
  }

  await markPartReceived(uploadId, index);
  return NextResponse.json({ ok: true, index, size: written });
}
