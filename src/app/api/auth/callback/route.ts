import { NextRequest, NextResponse } from "next/server";
import { safeNext, exchangeCode, oidcConfig } from "@/lib/oidc";
import { startSession } from "@/lib/auth";

/**
 * GET /api/auth/callback — the trip back from Authentik.
 *
 * Redeems the code for an identity, mirrors it locally and opens the session.
 * Anything that does not add up lands back on the front page without one: no
 * detailed error, because whoever arrives here with invented parameters has
 * not earned the hint.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const cfg = oidcConfig();
  if (!cfg) return back("/");

  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const state = params.get("state");

  const raw = request.cookies.get("docdrop_oidc")?.value;
  let stored: { verifier?: string; state?: string; next?: string } = {};
  try {
    stored = raw ? JSON.parse(raw) : {};
  } catch {
    stored = {};
  }

  const fail = () => {
    const res = back("/?error=signin");
    res.cookies.delete("docdrop_oidc");
    return res;
  };

  // The state has to match the one we issued: it is what stops somebody from
  // making us sign in with THEIR code.
  if (!code || !state || !stored.state || !stored.verifier || state !== stored.state) {
    return fail();
  }

  try {
    const identity = await exchangeCode(cfg, { code, verifier: stored.verifier });
    await startSession(identity);
  } catch (error) {
    console.error("[oidc callback]", error);
    return fail();
  }

  const next = safeNext(stored.next);
  const res = back(next);
  res.cookies.delete("docdrop_oidc");
  return res;
}

/**
 * Redirect to a RELATIVE target.
 *
 * NextResponse.redirect() insists on an absolute URL, and building one from
 * request.url yields "localhost" rather than the host the request came in on:
 * the browser lands on a different origin, does not send the session cookie
 * that was just set, and signing in looks broken. A relative Location is
 * resolved by the browser against where it already is, so it works behind the
 * tunnel, over Tailscale and on localhost alike.
 */
function back(path: string): NextResponse {
  return new NextResponse(null, { status: 302, headers: { Location: path } });
}
