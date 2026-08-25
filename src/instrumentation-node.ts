/**
 * Server startup (Node only). See `instrumentation.ts` for why this lives in its own
 * file.
 *
 * It does two things: log which mode the server started in, and kick off the
 * periodic sweep of the store.
 */
import { isConfigured } from "@/lib/auth";
import { MAX_TOTAL_BYTES, UPLOAD_DIR, cleanup } from "@/lib/store";
import { cleanupSessions } from "@/lib/upload-session";
import { cleanupGuestLinks } from "@/lib/guest";

/** How often expired content is purged. */
const SWEEP_INTERVAL = 60 * 60 * 1000;

const gib = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GiB`;

if (isConfigured()) {
  console.log("[docdrop] sign-in: Authentik (OIDC) — accounts live there, not here");
} else {
  console.error(
    "[docdrop] sign-in NOT configured: set DOCDROP_SESSION_SECRET and the " +
      "DOCDROP_OIDC_* variables, or nobody will be able to get in"
  );
}
console.log(`[docdrop] data in ${UPLOAD_DIR} · quota ${gib(MAX_TOTAL_BYTES)}`);

/**
 * Periodic sweep.
 *
 * Without this, an expired file was only deleted when someone tried to open it: a
 * multi-GB video that expired and nobody touched again kept eating into the quota
 * forever, until new uploads started failing with "Storage full" while nothing was
 * actually in use.
 */
async function sweep() {
  try {
    const abandoned = await cleanupSessions();
    const deleted = await cleanup();
    const guestLinks = await cleanupGuestLinks();
    if (deleted.length + abandoned.length + guestLinks > 0) {
      console.log(
        `[docdrop] sweep: ${deleted.length} expired, ` +
          `${abandoned.length} abandoned uploads, ${guestLinks} guest links`
      );
    }
  } catch (error) {
    console.error("[docdrop] sweep failed:", error);
  }
}

void sweep();
// unref() so the timer never keeps the process alive when it should exit.
setInterval(sweep, SWEEP_INTERVAL).unref();
console.log(`[docdrop] automatic sweep every ${SWEEP_INTERVAL / 60000} min`);
