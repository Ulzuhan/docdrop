import { NextRequest, NextResponse } from "next/server";
import { completeSession, readSession } from "@/lib/upload-session";
import { credencialDe, esDueno, requireUploadAccess } from "@/lib/guest";
import { isSameOriginMutation } from "@/lib/request-origin";

/**
 * POST /api/upload/[uploadId]/complete — closes the upload.
 *
 * Only succeeds when every chunk is present; if any is missing it answers 409 with
 * the list, so the client can re-send them instead of writing the upload off.
 */
export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/upload/[uploadId]/complete">
) {
  // Cerrar una subida es un POST sin cuerpo, así que la exigencia de
  // `application/json` que cubre a las demás no llega aquí: una página hermana
  // puede lanzarlo y el navegador manda la cookie, porque compartir dominio los
  // hace el mismo sitio. La comprobación de dueño no ayuda —la credencial que
  // viaja es la de la víctima—. Comprobado: devolvía 200.
  if (!isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });
  }

  const unauthorized = await requireUploadAccess(request);
  if (unauthorized) return unauthorized;

  const { uploadId } = await ctx.params;
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
