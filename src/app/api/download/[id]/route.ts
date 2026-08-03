import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";
import {
  blobPath,
  claimDownload,
  contentDisposition,
  isInlineSafe,
  isValidId,
  retireIfExhausted,
} from "@/lib/store";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/ratelimit";

const GONE = { expired: "File expired", exhausted: "Max downloads reached" } as const;

/**
 * GET /api/download/[id] — streams the file out.
 *
 * Notable behaviour:
 *  - Streamed, not buffered: readFile() used to pull the whole file into memory.
 *  - The download counter is incremented in a serialised way (see claimDownload);
 *    two simultaneous downloads used to be able to slip past the limit.
 *  - Range requests are supported, so large downloads can be resumed; a continuation
 *    Range request does not count as a new download.
 *  - Content-Length comes from the real file, not from the size stored in meta.json.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/download/[id]">) {
  // Public route (the id is the secret), but rate-limited so nobody uses the service
  // as a bandwidth cannon or tries to brute-force ids. The limit is generous because
  // a Range download generates several requests.
  const limit = rateLimit(`download:${clientIp(request)}`, 240, 60_000);
  if (!limit.allowed) return tooManyRequests(limit);

  const { id } = await ctx.params;

  if (!isValidId(id)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  // ?inline=1 serves the file for viewing in the browser (a <video> streaming, for
  // instance) instead of forcing a download. Previewing does not count as a download:
  // it would be absurd for opening the preview to burn the quota.
  const inline = request.nextUrl.searchParams.get("inline") === "1";

  const range = request.headers.get("range");
  const isContinuation = Boolean(range && !/^bytes=0-/.test(range));

  const claim = await claimDownload(id, !isContinuation && !inline);
  if (!claim.ok) {
    if (claim.reason === "not_found") {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
    return NextResponse.json({ error: GONE[claim.reason] }, { status: 410 });
  }
  const meta = claim.meta;

  let size: number;
  try {
    size = (await stat(blobPath(id))).size;
  } catch {
    return NextResponse.json({ error: "File data not found" }, { status: 404 });
  }

  // Only content that cannot run scripts in our origin is served inline.
  const serveInline = inline && isInlineSafe(meta.mimeType);

  const headers = new Headers({
    "Content-Type": meta.mimeType,
    "Content-Disposition": contentDisposition(meta.originalName, serveInline),
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  });

  // ─── Partial request (Range) ───────────────────────────────────────
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match || (match[1] === "" && match[2] === "")) {
      return new NextResponse(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }

    let start: number;
    let end: number;
    if (match[1] === "") {
      // bytes=-N → the last N bytes
      const suffix = Number(match[2]);
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      return new NextResponse(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }

    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    headers.set("Content-Length", String(end - start + 1));

    const partial = createReadStream(blobPath(id), { start, end });
    if (!inline) partial.on("close", () => void retireIfExhausted(id).catch(() => {}));
    return new NextResponse(Readable.toWeb(partial) as unknown as ReadableStream, {
      status: 206,
      headers,
    });
  }

  // ─── Full transfer ─────────────────────────────────────────────────
  headers.set("Content-Length", String(size));

  const stream = createReadStream(blobPath(id));
  // When the transfer ends, if this was the last allowed download, it is burned.
  // A preview does not consume downloads, so it cannot exhaust them either.
  if (!inline) stream.on("close", () => void retireIfExhausted(id).catch(() => {}));

  return new NextResponse(Readable.toWeb(stream) as unknown as ReadableStream, {
    status: 200,
    headers,
  });
}
