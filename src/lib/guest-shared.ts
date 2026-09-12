/** Browser-facing guest-link constants. The server implementation lives in Go. */

/**
 * TTL of files uploaded through the guest page. Fixed rather than user-picked:
 * a guest is handing something over, not managing storage. The server clamps it
 * to its own guest maximum (`auth.MaxTTLFicheroInvitadoHoras`) regardless.
 */
export const GUEST_UPLOAD_TTL_HOURS = 24;
