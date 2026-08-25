import { NextResponse } from "next/server";
import { cleanup } from "@/lib/store";
import { cleanupSessions } from "@/lib/upload-session";
import { cleanupGuestLinks } from "@/lib/guest";
import { requireSession } from "@/lib/auth";

/**
 * POST /api/cleanup — deletes what expired, what ran out of downloads and the
 * orphaned directories left behind by interrupted uploads.
 *
 * Requires a session: left open, anyone could force purges. The server also sweeps
 * on its own every hour (see instrumentation-node.ts), so this is only for forcing
 * it by hand.
 */
export async function POST() {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  // Abandoned chunked uploads first: they release the space they had reserved and
  // stop being protected from the general sweep.
  const abandoned = await cleanupSessions();
  const deleted = await cleanup();
  const expiredGuestLinks = await cleanupGuestLinks();

  return NextResponse.json({
    deleted,
    abandonedUploads: abandoned,
    expiredGuestLinks,
    count: deleted.length + abandoned.length,
    timestamp: Date.now(),
  });
}
