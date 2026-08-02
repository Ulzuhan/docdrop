import { NextResponse } from "next/server";
import { isValidId, readMeta, unavailableReason } from "@/lib/store";

const GONE = {
  expired: "File expired",
  exhausted: "Max downloads reached",
} as const;

/** GET /api/info/[id] — metadatos del fichero, sin consumir una descarga. */
export async function GET(_request: Request, ctx: RouteContext<"/api/info/[id]">) {
  const { id } = await ctx.params;

  if (!isValidId(id)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const meta = await readMeta(id);
  if (!meta) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const reason = unavailableReason(meta);
  if (reason) {
    return NextResponse.json({ error: GONE[reason], reason }, { status: 410 });
  }

  return NextResponse.json(meta);
}
