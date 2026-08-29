import { NextRequest, NextResponse } from "next/server";
import { safeNext, authorizeUrl, challengeFor, newVerifier, oidcConfig } from "@/lib/oidc";

/**
 * GET /api/auth/login — starts signing in against Authentik.
 *
 * The PKCE verifier, the anti-CSRF state and where to return to are kept in a
 * short-lived cookie. A cookie rather than server state because there is no
 * session yet: this happens before we know who is asking.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const cfg = oidcConfig();
  if (!cfg) {
    return NextResponse.json(
      { error: "Sign-in is not configured on this instance" },
      { status: 503 }
    );
  }

  const verifier = newVerifier();
  const state = newVerifier();

  // Internal paths only: without this, a link carrying ?next=https://elsewhere
  // would turn signing in into a redirector to wherever an attacker wanted.
  const raw = request.nextUrl.searchParams.get("next") ?? "/";
  const next = safeNext(raw);

  const response = NextResponse.redirect(
    await authorizeUrl(cfg, { state, codeChallenge: challengeFor(verifier) })
  );
  response.cookies.set("docdrop_oidc", JSON.stringify({ verifier, state, next }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // "strict" would not survive the trip back from Authentik: the browser
    // treats it as a cross-site navigation and would withhold the cookie.
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  });
  return response;
}
