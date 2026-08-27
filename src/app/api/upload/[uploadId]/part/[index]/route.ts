import { NextRequest, NextResponse } from "next/server";
import { createWriteStream } from "fs";
import { createHash } from "crypto";
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
import { credencialDe, esDueno, requireUploadAccess } from "@/lib/guest";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/ratelimit";

/**
 * PUT /api/upload/[uploadId]/part/[index] — receives one chunk.
 *
 * The body is the raw chunk and it is written straight into its position inside the
 * final file, so nothing needs assembling afterwards.
 *
 * It is idempotent: re-sending an already received chunk answers 200 without writing
 * it again, which is what makes retrying safe when the network fails mid-way.
 */
export async function PUT(
  request: NextRequest,
  ctx: RouteContext<"/api/upload/[uploadId]/part/[index]">
) {
  const unauthorized = await requireUploadAccess(request);
  if (unauthorized) return unauthorized;

  // Generous quota: a large upload is hundreds of legitimate chunks.
  const limit = rateLimit(`upload-part:${clientIp(request)}`, 5000, 60 * 60 * 1000);
  if (!limit.allowed) return tooManyRequests(limit);

  const { uploadId, index: rawIndex } = await ctx.params;

  const session = await readSession(uploadId);
  if (!session) {
    return NextResponse.json({ error: "Upload session not found" }, { status: 404 });
  }
  // Tener acceso y ser el dueño de ESTA subida son cosas distintas. Sin esto, con
  // dos enlaces de invitado el segundo escribía el trozo 0 del fichero que estaba
  // subiendo el primero, le leía el nombre del documento y le cancelaba la subida.
  // Mismo 404 que si no existiera: quien no es de aquí no tiene por qué enterarse
  // de que hay algo.
  if (!esDueno(session.owner, await credencialDe(request))) {
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

  // The client may send the chunk's SHA-256. With automatic retries and resuming in
  // play, a corrupted chunk would go unnoticed: the size would add up and it would
  // be accepted. The header is optional because crypto.subtle only exists in secure
  // contexts (HTTPS or localhost).
  const declaredHash = request.headers.get("x-chunk-sha256")?.trim().toLowerCase() || null;
  const hasher = declaredHash ? createHash("sha256") : null;

  let written = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      if (written > expected) {
        cb(Object.assign(new Error("Part larger than expected"), { code: "PART_TOO_LARGE" }));
        return;
      }
      hasher?.update(chunk);
      cb(null, chunk);
    },
  });

  try {
    const source = Readable.fromWeb(request.body as unknown as NodeWebReadableStream);
    // 'r+' opens without truncating and `start` places the write at the chunk offset.
    await pipeline(source, counter, createWriteStream(blobPath(uploadId), { flags: "r+", start }));
  } catch (error) {
    if ((error as { code?: string }).code === "PART_TOO_LARGE") {
      return NextResponse.json({ error: "Part larger than expected" }, { status: 413 });
    }
    console.error("Part upload error:", error);
    return NextResponse.json({ error: "Part upload failed" }, { status: 500 });
  }

  // A short chunk means the connection dropped mid-way: it is not marked as
  // received, so the client retries and overwrites the same range.
  if (written !== expected) {
    return NextResponse.json(
      { error: "Incomplete part", expected, received: written },
      { status: 400 }
    );
  }

  // Integrity: on mismatch it is NOT marked as received, so the client re-sends it
  // and overwrites the same range of the file.
  if (hasher) {
    const actual = hasher.digest("hex");
    if (actual !== declaredHash) {
      return NextResponse.json(
        { error: "Checksum mismatch", expected: declaredHash, actual },
        { status: 422 }
      );
    }
  }

  await markPartReceived(uploadId, index);
  return NextResponse.json({ ok: true, index, size: written });
}
