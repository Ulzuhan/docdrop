import { NextResponse } from "next/server";
import { revokeGuestLink } from "@/lib/guest";
import { requireSession } from "@/lib/auth";

/** DELETE /api/guest-links/[token] — revokes a guest link immediately. */
export async function DELETE(
  _request: Request,
  ctx: RouteContext<"/api/guest-links/[token]">
) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { token } = await ctx.params;
  const existed = await revokeGuestLink(token);
  if (!existed) {
    return NextResponse.json({ error: "Guest link not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
