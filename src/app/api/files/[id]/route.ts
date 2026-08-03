import { NextResponse } from "next/server";
import { deleteEntry, isValidId, readMeta } from "@/lib/store";
import { requireSession } from "@/lib/auth";

/**
 * DELETE /api/files/[id] — deletes a file before it expires.
 *
 * The dashboard listing used to be read-only, so the only way to free space was to
 * wait for expiry. With a storage quota in place that matters.
 */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/files/[id]">) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { id } = await ctx.params;
  if (!isValidId(id)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const meta = await readMeta(id);
  if (!meta) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  await deleteEntry(id);
  return NextResponse.json({ ok: true, id });
}
