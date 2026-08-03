import { NextRequest, NextResponse } from "next/server";

/**
 * Target declared in the manifest for the system's "Share" menu.
 *
 * Normally this route never runs: the service worker intercepts the POST, stores the
 * file and redirects to the page. This is only the safety net for when the worker is
 * not active yet, so sharing does not end in an unexplained 405.
 */
export async function POST(request: NextRequest) {
  return NextResponse.redirect(new URL("/?shared=error", request.url), 303);
}

export async function GET(request: NextRequest) {
  return NextResponse.redirect(new URL("/", request.url), 307);
}
