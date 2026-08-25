import { NextResponse } from "next/server";
import { completeSession, readSession } from "@/lib/upload-session";
import { requireUploadAccess } from "@/lib/guest";

/**
 * POST /api/upload/[uploadId]/complete — closes the upload.
 *
 * Only succeeds when every chunk is present; if any is missing it answers 409 with
 * the list, so the client can re-send them instead of writing the upload off.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/upload/[uploadId]/complete">
) {
  const unauthorized = await requireUploadAccess(request);
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
