import { NextRequest, NextResponse } from "next/server";
import { MAX_FILE_SIZE, clampTtlHours, withQuota } from "@/lib/store";
import { CHUNK_SIZE, createSession } from "@/lib/upload-session";
import {
  MAX_GUEST_FILE_TTL_HOURS,
  guestFromRequest,
  recordGuestUpload,
  requireUploadAccess,
} from "@/lib/guest";
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

  let body: {
    filename?: unknown;
    size?: unknown;
    mimeType?: unknown;
    ttlHours?: unknown;
    maxDownloads?: unknown;
    uploadedBy?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

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
  // the bare token. The label of the link doubles as the uploader name when the
  // guest did not give one, so the listing shows whom the file came from.
  const ttlHours = guest
    ? Math.min(clampTtlHours(body.ttlHours), MAX_GUEST_FILE_TTL_HOURS)
    : body.ttlHours;
  // Somebody with an account is labelled with it; a guest, with the label of
  // their link. The name sent by the client is only honoured when there is no
  // account behind the upload, because then it is all there is.
  const account = guest ? null : await currentUser();
  const uploadedBy = account
    ? displayName(account)
    : (body.uploadedBy ?? (guest ? guest.label : undefined));

  const session = await withQuota(size, () =>
    createSession({
      filename,
      size,
      mimeType: typeof body.mimeType === "string" ? body.mimeType : undefined,
      ttlHours,
      maxDownloads: body.maxDownloads,
      uploadedBy,
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
