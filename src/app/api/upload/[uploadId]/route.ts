import { NextResponse } from "next/server";
import { abortSession, readSession, receivedParts } from "@/lib/upload-session";
import { requireSession } from "@/lib/auth";

/**
 * GET /api/upload/[uploadId] — estado de una subida en curso.
 *
 * Es lo que permite retomarla: el cliente pregunta qué trozos han llegado y envía
 * solo los que faltan, en vez de empezar de cero tras un corte de red.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/upload/[uploadId]">) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { uploadId } = await ctx.params;
  const session = await readSession(uploadId);
  if (!session) {
    return NextResponse.json({ error: "Upload session not found" }, { status: 404 });
  }
  if (session.sessionExpiresAt < Date.now()) {
    return NextResponse.json({ error: "Upload session expired" }, { status: 410 });
  }

  const received = await receivedParts(uploadId);
  return NextResponse.json({
    uploadId: session.id,
    originalName: session.originalName,
    size: session.size,
    chunkSize: session.chunkSize,
    totalParts: session.totalParts,
    received,
    complete: received.length === session.totalParts,
  });
}

/** DELETE /api/upload/[uploadId] — cancela y borra lo subido hasta ahora. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/upload/[uploadId]">) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { uploadId } = await ctx.params;
  const session = await readSession(uploadId);
  if (!session) {
    return NextResponse.json({ error: "Upload session not found" }, { status: 404 });
  }

  await abortSession(uploadId);
  return NextResponse.json({ ok: true });
}
