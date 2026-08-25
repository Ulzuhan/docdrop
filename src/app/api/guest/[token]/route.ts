import { NextResponse } from "next/server";
import { validGuestLink } from "@/lib/guest";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/ratelimit";

/**
 * GET /api/guest/[token] — is this guest link usable?
 *
 * Public on purpose: the guest page asks before showing the uploader, and the
 * token in the URL is the credential being checked. Only reveals what the link
 * holder is entitled to know: that it works, whom it was made for, and until
 * when. Never enumerates anything.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/guest/[token]">) {
  // Same shape as the login limiter: this endpoint is the only oracle for
  // guessing tokens, so probing it gets expensive fast. 128-bit tokens make the
  // guessing hopeless anyway; the limit just keeps the noise down.
  const limit = rateLimit(`guest-check:${clientIp(request)}`, 30, 15 * 60 * 1000);
  if (!limit.allowed) return tooManyRequests(limit);

  const { token } = await ctx.params;
  const link = await validGuestLink(token);
  if (!link) {
    return NextResponse.json({ error: "This guest link is no longer valid" }, { status: 404 });
  }

  return NextResponse.json({
    label: link.label ?? null,
    expiresAt: link.expiresAt,
  });
}
