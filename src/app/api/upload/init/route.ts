import { NextRequest, NextResponse } from "next/server";
import { jsonBody } from "@/lib/body";
import { MAX_FILE_SIZE, clampTtlHours, withQuota } from "@/lib/store";
import { CHUNK_SIZE, createSession } from "@/lib/upload-session";
import { MAX_GUEST_FILE_TTL_HOURS,
  guestFromRequest,
  recordGuestUpload,
  requireUploadAccess, } from "@/lib/guest";
import { currentUser } from "@/lib/auth";
import { displayName } from "@/lib/users";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/ratelimit";

/**
 * POST /api/upload/init — opens a chunked upload.
 *
 * body: { filename, size, mimeType?, ttlHours?, maxDownloads?, uploadedBy? }
 * → { uploadId, chunkSize, totalParts, received: [] }
 *
 * The per-IP limit is applied here rather than per chunk: a 7 GB upload is hundreds
 * of chunk requests, and counting them all would burn through the quota instantly.
 */
export async function POST(request: NextRequest) {
  const unauthorized = await requireUploadAccess(request);
  if (unauthorized) return unauthorized;

  // Resolved once and reused: the guest link (when there is one) also decides
  // the TTL ceiling and the default uploader label below.
  const guest = await guestFromRequest(request);

  const limit = rateLimit(`upload-init:${clientIp(request)}`, 30, 60 * 60 * 1000);
  if (!limit.allowed) return tooManyRequests(limit);

  // `null` es JSON válido: pasaba el catch y reventaba al leer un campo.
  const cuerpo = await jsonBody(request);
  if (!cuerpo) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const body: {
    filename?: unknown;
    size?: unknown;
    mimeType?: unknown;
    ttlHours?: unknown;
    maxDownloads?: unknown;
  } = cuerpo;

  const filename = typeof body.filename === "string" ? body.filename : "";
  const size = Number(body.size);

  if (!filename) {
    return NextResponse.json({ error: "filename is required" }, { status: 400 });
  }
  if (!Number.isFinite(size) || size <= 0 || !Number.isSafeInteger(size)) {
    return NextResponse.json({ error: "size must be a positive integer" }, { status: 400 });
  }
  if (size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: "File too large" }, { status: 413 });
  }

  // The quota is checked up front — no point letting half a film upload only to be
  // rejected at the end — and the space is reserved under the same lock as the
  // check, so two uploads starting at once cannot both claim the last free gigabyte.
  // A guest's files expire sooner (MAX_GUEST_FILE_TTL_HOURS): the cap is enforced
  // here rather than trusted to the guest page, because the API is reachable with
  // the bare token. A guest's files are labelled with the label of their link,
  // which the account that issued it chose.
  const ttlHours = guest
    ? Math.min(clampTtlHours(body.ttlHours), MAX_GUEST_FILE_TTL_HOURS)
    : body.ttlHours;
  // Somebody with an account is labelled with it; a guest, with the label of
  // their link. Nothing the client types reaches this field any more: a
  // free-text name next to a mandatory sign-in was only good for pretending to
  // be somebody else in the listing.
  const account = guest ? null : await currentUser();
  const uploadedBy = account ? displayName(account) : guest?.label;

  // Quién abre esta subida, para que nadie más pueda meterse en ella. Sale de lo
  // que ya se ha resuelto arriba y no de una segunda consulta. Si no hay ni
  // invitado ni cuenta —instancia sin identidad configurada— queda sin dueño, y
  // entonces se comporta como antes: no hay a quién distinguir.
  const owner = guest ? `guest:${guest.token}` : account ? `user:${account.id}` : undefined;

  const session = await withQuota(size, () =>
    createSession({
      owner,
      filename,
      size,
      mimeType: typeof body.mimeType === "string" ? body.mimeType : undefined,
      ttlHours,
      maxDownloads: body.maxDownloads,
      uploadedBy,
      // Autodeclarado por el cliente y sin nada que verificar: al servidor le da
      // igual qué bytes custodia. La marca solo cambia qué camino toma la
      // página de descarga, y mentir aquí solo le rompe la descarga a quien
      // mintió. Ver docs/24 de kaicorplabs.
      encrypted: (body as { encrypted?: unknown }).encrypted === true,
    })
  );

  if (!session) {
    return NextResponse.json(
      { error: "Not enough storage left for this file." },
      { status: 507 }
    );
  }

  if (guest) await recordGuestUpload(guest.token);

  return NextResponse.json({
    uploadId: session.id,
    chunkSize: CHUNK_SIZE,
    totalParts: session.totalParts,
    received: [],
  });
}
