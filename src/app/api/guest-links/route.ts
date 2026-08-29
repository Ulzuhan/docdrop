import { NextRequest, NextResponse } from "next/server";
import { jsonBody } from "@/lib/body";
import { createGuestLink, listGuestLinks } from "@/lib/guest";
import { currentUser, requireSession } from "@/lib/auth";
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

  // Los tuyos, no los de todos. La sesión bastaba y cualquier cuenta veía —y
  // podía revocar— los enlaces de las demás: mismo fallo de fondo que el
  // listado de ficheros, la cuenta era la puerta pero no el inquilino. Los
  // emitidos antes de que los enlaces llevaran emisor no se enseñan a nadie y
  // caducan solos.
  const me = await currentUser();
  const links = (await listGuestLinks()).filter((l) => l.createdBy && l.createdBy === me?.id);
  return NextResponse.json({ links });
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

  // `null` es JSON válido: pasaba el catch y reventaba al leer un campo.
  const cuerpo = await jsonBody(request);
  if (!cuerpo) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const body: { ttlHours?: unknown; label?: unknown } = cuerpo;

  // Con su emisor: es lo que hace que lo subido por el enlace aparezca en el
  // panel de quien lo repartió, y que nadie más pueda listarlo ni revocarlo.
  const me = await currentUser();
  const link = await createGuestLink({ ...body, createdBy: me?.id });
  return NextResponse.json({ link }, { status: 201 });
}
