/** Browser-facing guest-link types. The server implementation lives in Go. */

/**
 * TTL of files uploaded through the guest page. Fixed rather than user-picked:
 * a guest is handing something over, not managing storage. Must stay at or
 * below MAX_GUEST_FILE_TTL_HOURS in lib/guest.ts, which the server enforces.
 */
export const GUEST_UPLOAD_TTL_HOURS = 24;
