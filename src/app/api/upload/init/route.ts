import { NextRequest, NextResponse } from "next/server";
import { MAX_FILE_SIZE, MAX_TOTAL_BYTES, usedBytes } from "@/lib/store";
import { CHUNK_SIZE, createSession } from "@/lib/upload-session";
import { requireSession } from "@/lib/auth";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/ratelimit";

/**
 * POST /api/upload/init — abre una subida por trozos.
 *
 * body: { filename, size, mimeType?, ttlHours?, maxDownloads? }
 * → { uploadId, chunkSize, totalParts, received: [] }
 *
 * El límite por IP se aplica aquí y no en cada trozo: una subida de 7 GB son
 * cientos de peticiones de trozo, y contarlas todas agotaría el cupo enseguida.
 */
export async function POST(request: NextRequest) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const limit = rateLimit(`upload-init:${clientIp(request)}`, 30, 60 * 60 * 1000);
  if (!limit.allowed) return tooManyRequests(limit);

  let body: { filename?: unknown; size?: unknown; mimeType?: unknown; ttlHours?: unknown; maxDownloads?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const filename = typeof body.filename === "string" ? body.filename : "";
  const size = Number(body.size);

  if (!filename) {
    return NextResponse.json({ error: "filename is required" }, { status: 400 });
  }
  if (!Number.isFinite(size) || size <= 0 || !Number.isSafeInteger(size)) {
    return NextResponse.json({ error: "size must be a positive integer" }, { status: 400 });
  }
  if (size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: "File too large" }, { status: 413 });
  }

  // La cuota se comprueba por adelantado: no tiene sentido dejar que suba media
  // película para rechazarla al final.
  const used = await usedBytes();
  if (used + size > MAX_TOTAL_BYTES) {
    return NextResponse.json(
      { error: "Not enough storage left for this file." },
      { status: 507 }
    );
  }

  const session = await createSession({
    filename,
    size,
    mimeType: typeof body.mimeType === "string" ? body.mimeType : undefined,
    ttlHours: body.ttlHours,
    maxDownloads: body.maxDownloads,
  });

  return NextResponse.json({
    uploadId: session.id,
    chunkSize: CHUNK_SIZE,
    totalParts: session.totalParts,
    received: [],
  });
}
