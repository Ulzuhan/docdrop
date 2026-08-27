import { NextRequest, NextResponse } from "next/server";
import { jsonBody } from "@/lib/body";
import { createGuestLink, listGuestLinks } from "@/lib/guest";
import { requireSession } from "@/lib/auth";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/ratelimit";

/**
 * GET /api/guest-links — active guest links, newest first.
 *
 * Owner only: the listing exposes every live token, so leaving it public would
 * hand out upload access to anyone who asked.
 */
export async function GET() {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  return NextResponse.json({ links: await listGuestLinks() });
}

/**
 * POST /api/guest-links — mints a guest upload link.
 *
 * body: { ttlHours?, label? } → { link }
 */
export async function POST(request: NextRequest) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  // Modest cap: links are minted by a person, not a script. Mostly protection
  // against a runaway client filling the guests directory.
  const limit = rateLimit(`guest-links:${clientIp(request)}`, 30, 60 * 60 * 1000);
  if (!limit.allowed) return tooManyRequests(limit);

  let body: { ttlHours?: unknown; label?: unknown };
  // `null` es JSON válido: pasaba el catch y reventaba al leer un campo.
  const cuerpo = await jsonBody(request);
  if (!cuerpo) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  body = cuerpo;

  const link = await createGuestLink(body);
  return NextResponse.json({ link }, { status: 201 });
}
