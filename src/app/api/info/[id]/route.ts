import { NextResponse } from "next/server";
import { isValidId, readMeta, unavailableReason } from "@/lib/store";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/ratelimit";

const GONE = {
  expired: "File expired",
  exhausted: "Max downloads reached",
} as const;

/** GET /api/info/[id] — file metadata, without consuming a download. Public. */
export async function GET(request: Request, ctx: RouteContext<"/api/info/[id]">) {
  const limit = rateLimit(`info:${clientIp(request)}`, 120, 60_000);
  if (!limit.allowed) return tooManyRequests(limit);

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
