import { NextResponse } from "next/server";
import { open } from "fs/promises";
import { blobPath, isValidId, readMeta, unavailableReason } from "@/lib/store";
import { leerPrefijo } from "@/lib/e2ee";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/ratelimit";

const GONE = {
  expired: "File expired",
  exhausted: "Max downloads reached",
} as const;

/** A header bigger than this is not ours: the JSON inside is a name and a type. */
const MAX_HEADER = 64 * 1024;

/**
 * GET /api/info/[id] — what a recipient may know before downloading. Public.
 *
 * Says only what the page needs. It used to return meta.json whole, owner and
 * all, to anybody holding the link.
 *
 * For an encrypted file it also carries the ENCRYPTED header of the bulk: the
 * first bytes of the blob, where the real name, type and size live under the
 * key. The server cannot read it and neither can anyone without the fragment,
 * so handing it out costs nothing — and it is what lets the recipient see what
 * they are about to download instead of "Encrypted file", without spending a
 * download on it.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/info/[id]">) {
  const limit = rateLimit(`info:${clientIp(request)}`, 120, 60_000);
  if (!limit.allowed) return tooManyRequests(limit);

  const { id } = await ctx.params;

  if (!isValidId(id)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const meta = await readMeta(id);
  if (!meta) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const reason = unavailableReason(meta);
  if (reason) {
    return NextResponse.json({ error: GONE[reason], reason }, { status: 410 });
  }

  return NextResponse.json({
    id: meta.id,
    originalName: meta.originalName,
    size: meta.size,
    mimeType: meta.mimeType,
    uploadedAt: meta.uploadedAt,
    expiresAt: meta.expiresAt,
    downloadCount: meta.downloadCount,
    maxDownloads: meta.maxDownloads,
    uploadedBy: meta.uploadedBy,
    encrypted: meta.encrypted === true,
    header: meta.encrypted ? await encryptedHeader(id) : undefined,
  });
}

/** The bulk's prefix — magic, chunk size and the encrypted header — as base64. */
async function encryptedHeader(id: string): Promise<string | undefined> {
  let fh;
  try {
    fh = await open(blobPath(id), "r");
    const first = Buffer.alloc(12);
    const { bytesRead } = await fh.read(first, 0, 12, 0);
    if (bytesRead < 12) return undefined;
    const hdrLen = first.readUInt32BE(8);
    if (hdrLen > MAX_HEADER) return undefined;
    const prefix = Buffer.alloc(12 + hdrLen);
    const got = await fh.read(prefix, 0, prefix.length, 0);
    if (got.bytesRead < prefix.length) return undefined;
    return leerPrefijo(new Uint8Array(prefix)) ? prefix.toString("base64") : undefined;
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => {});
  }
}
