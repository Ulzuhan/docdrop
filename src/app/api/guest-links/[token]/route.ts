import { NextResponse } from "next/server";
import { readGuestLink, revokeGuestLink } from "@/lib/guest";
import { currentUser, requireSession } from "@/lib/auth";

/** DELETE /api/guest-links/[token] — revokes a guest link immediately. */
export async function DELETE(
  _request: Request,
  ctx: RouteContext<"/api/guest-links/[token]">
) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { token } = await ctx.params;
  // Solo su emisor lo revoca, y un enlace ajeno contesta lo mismo que uno
  // inexistente: la respuesta no debe servir para sondear tokens de otros.
  const me = await currentUser();
  const link = await readGuestLink(token);
  if (!link || !link.createdBy || link.createdBy !== me?.id) {
    return NextResponse.json({ error: "Guest link not found" }, { status: 404 });
  }
  const existed = await revokeGuestLink(token);
  if (!existed) {
    return NextResponse.json({ error: "Guest link not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
