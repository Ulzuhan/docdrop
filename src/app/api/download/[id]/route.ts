import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";
import {
  blobPath, claimDownload, contentDisposition, isInlineSafe,
  isResumedTransfer, isValidId, registerTransfer,
} from "@/lib/store";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/ratelimit";

const GONE = { expired: "File expired", exhausted: "Max downloads reached" } as const;

/** Parse a single byte range before taking a download slot. */
function byteRange(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return null;
  if (!match[1] && last === 0) return null;
  const start = match[1] ? first : Math.max(0, size - last);
  const end = match[1] && match[2] ? Math.min(last, size - 1) : size - 1;
  return start <= end && start < size ? { start, end } : null;
}

/** Public capability download. Only completed, accounted responses enable continuations. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/download/[id]">) {
  const client = clientIp(request);
  const limit = rateLimit(`download:${client}`, 240, 60_000);
  if (!limit.allowed) return tooManyRequests(limit);
  const { id } = await ctx.params;
  if (!isValidId(id)) return NextResponse.json({ error: "File not found" }, { status: 404 });

  // Check availability without reserving anything: bad ranges and missing blobs
  // must neither consume a slot nor establish a free continuation.
  const available = await claimDownload(id, false);
  if (!available.ok) {
    return NextResponse.json({ error: available.reason === "not_found" ? "File not found" : GONE[available.reason] },
      { status: available.reason === "not_found" ? 404 : 410 });
  }
  let size: number;
  try {
    size = (await stat(blobPath(id))).size;
  } catch {
    return NextResponse.json({ error: "File data not found" }, { status: 404 });
  }
  const range = request.headers.get("range");
  const partial = range === null ? null : byteRange(range, size);
  if (range !== null && !partial) {
    return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }

  // Inline previews retain their existing semantics, only for safe media types.
  const preview = request.nextUrl.searchParams.get("inline") === "1" && isInlineSafe(available.meta.mimeType);
  const resuming = range !== null && isResumedTransfer(id, client);
  // Recheck under the per-file lock: availability can change during stat/validation.
  const claim = await claimDownload(id, !preview && !resuming);
  if (!claim.ok) {
    return NextResponse.json({ error: claim.reason === "not_found" ? "File not found" : GONE[claim.reason] },
      { status: claim.reason === "not_found" ? 404 : 410 });
  }

  try {
    const headers = new Headers({
      "Content-Type": claim.meta.mimeType,
      "Content-Disposition": contentDisposition(claim.meta.originalName, preview),
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Length": String(partial ? partial.end - partial.start + 1 : size),
    });
    if (partial) headers.set("Content-Range", `bytes ${partial.start}-${partial.end}/${size}`);
    const source = createReadStream(blobPath(id), partial ?? undefined);
    const reader = (Readable.toWeb(source) as ReadableStream<Uint8Array>).getReader();

    // Await accounting before closing the response. A Node 'end' event alone
    // can precede cancellation of the web response while bytes are still buffered.
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (cancelled) return;
          if (!chunk.done) {
            controller.enqueue(chunk.value);
            return;
          }
          await claim.done(true);
          if (!preview) registerTransfer(id, client);
          controller.close();
        } catch (error) {
          await claim.done(false);
          if (!cancelled) controller.error(error);
        }
      },
      async cancel(reason) {
        cancelled = true;
        try { await reader.cancel(reason); }
        finally { await claim.done(false); }
      },
    }, { highWaterMark: 0 });
    return new NextResponse(body, { status: partial ? 206 : 200, headers });
  } catch (error) {
    await claim.done(false);
    throw error;
  }
}
