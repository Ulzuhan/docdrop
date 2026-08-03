import { NextResponse } from "next/server";
import { abortSession, readSession, receivedParts } from "@/lib/upload-session";
import { requireSession } from "@/lib/auth";

/**
 * GET /api/upload/[uploadId] — status of an upload in flight.
 *
 * This is what makes resuming possible: the client asks which chunks arrived and
 * sends only the missing ones, instead of starting over after a network drop.
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

/** DELETE /api/upload/[uploadId] — cancels and deletes what was uploaded so far. */
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
