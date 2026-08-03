import { NextResponse } from "next/server";
import { completeSession, readSession } from "@/lib/upload-session";
import { requireSession } from "@/lib/auth";

/**
 * POST /api/upload/[uploadId]/complete — cierra la subida.
 *
 * Solo tiene éxito si están todos los trozos; si falta alguno responde 409 con la
 * lista, para que el cliente los reenvíe en vez de dar la subida por perdida.
 */
export async function POST(
  _request: Request,
  ctx: RouteContext<"/api/upload/[uploadId]/complete">
) {
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

  const result = await completeSession(session);
  if (!result.ok) {
    return NextResponse.json(
      { error: "Missing parts", missing: result.missing },
      { status: 409 }
    );
  }

  return NextResponse.json({
    id: result.meta.id,
    originalName: result.meta.originalName,
    size: result.meta.size,
    expiresAt: result.meta.expiresAt,
    maxDownloads: result.meta.maxDownloads,
    downloadUrl: `/d/${result.meta.id}`,
  });
}
