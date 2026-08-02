import { NextResponse } from "next/server";
import { deleteEntry, isValidId, readMeta } from "@/lib/store";
import { requireSession } from "@/lib/auth";

/**
 * DELETE /api/files/[id] — borra un fichero antes de que caduque.
 *
 * Faltaba: la lista del panel solo dejaba mirar, así que la única forma de liberar
 * espacio era esperar a la caducidad. Con la cuota de almacenamiento eso importa.
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
