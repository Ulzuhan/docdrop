import { NextResponse } from "next/server";
import { deleteEntry, isValidId, readMeta } from "@/lib/store";
import { currentUser, requireSession } from "@/lib/auth";

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

  // Solo su dueño borra, y un fichero ajeno contesta lo mismo que uno que no
  // existe: este endpoint no debe servir para comprobar qué ids hay. Antes
  // bastaba la sesión, así que cualquier cuenta podía borrar lo de todas.
  // Un fichero sin dueño no lo borra nadie desde aquí: caduca solo.
  const me = await currentUser();
  if (!meta.owner || meta.owner !== `user:${me?.id}`) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  await deleteEntry(id);
  return NextResponse.json({ ok: true, id });
}
