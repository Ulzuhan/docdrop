import { NextResponse } from "next/server";
import { MAX_TOTAL_BYTES, isAvailable, listMeta, usedBytes } from "@/lib/store";
import { authRequired, requireSession } from "@/lib/auth";

/**
 * GET /api/files — active files, newest first.
 *
 * Always reads from disk, the single source of truth; /api/upload used to serve a
 * second listing from an in-memory cache that showed stale counters.
 */
export async function GET() {
  // Requires a session: this listing enumerates EVERY active link, so leaving it
  // public would be the same as publishing every file.
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const now = Date.now();
  const files = (await listMeta())
    .filter((meta) => isAvailable(meta, now))
    .sort((a, b) => b.uploadedAt - a.uploadedAt);

  return NextResponse.json({
    files,
    storage: { usedBytes: await usedBytes(), totalBytes: MAX_TOTAL_BYTES },
    // So the dashboard knows whether to offer a "log out" button.
    authEnabled: authRequired(),
  });
}
