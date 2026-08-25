import { NextResponse } from "next/server";
import { endSession } from "@/lib/auth";

/**
 * POST /api/auth/logout — ends the session for THIS application.
 *
 * It deliberately does not sign you out of Authentik: somebody leaving DocDrop
 * does not expect to be thrown out of the other services open in their other
 * tabs. To leave everything, sign out in Authentik itself.
 */
export async function POST() {
  await endSession();
  return NextResponse.json({ ok: true });
}
