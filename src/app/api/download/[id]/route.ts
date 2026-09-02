import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";
import {
  blobPath,
  claimDownload,
  contentDisposition,
  isInlineSafe,
  isResumedTransfer,
  isValidId,
  readMeta,
  registerTransfer,
} from "@/lib/store";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/ratelimit";

const GONE = { expired: "File expired", exhausted: "Max downloads reached" } as const;

/**
 * GET /api/download/[id] — streams the file out.
 *
 * Notable behaviour:
 *  - Streamed, not buffered: readFile() used to pull the whole file into memory.
 *  - The download counter moves when the last byte has gone out (see claimDownload):
 *    a transfer that is cut short does not burn anybody's quota, and a request in
 *    flight still holds its place so two at once cannot slip past the limit.
 *  - Range requests are supported, so large downloads can be resumed; continuing a
 *    transfer that was already counted does not count as a new download.
 *  - Content-Length comes from the real file, not from the size stored in meta.json.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/download/[id]">) {
  // Public route (the id is the secret), but rate-limited so nobody uses the service
  // as a bandwidth cannon or tries to brute-force ids. The limit is generous because
  // a Range download generates several requests.
  const client = clientIp(request);
  const limit = rateLimit(`download:${client}`, 240, 60_000);
  if (!limit.allowed) return tooManyRequests(limit);

  const { id } = await ctx.params;

  if (!isValidId(id)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  // ?inline=1 serves the file for viewing in the browser (a <video> streaming, for
  // instance) instead of forcing a download. Previewing does not count as a download:
  // it would be absurd for opening the preview to burn the quota.
  //
  // Only types the browser can actually display qualify. Asking for a .zip inline is
  // not a preview, it is the download — and it used to be served free of charge,
  // unlimited times, for any type at all.
  //
  // The type is what decides whether this counts, so the metadata has to be read
  // before claiming. claimDownload() reads it again under its own lock; that read is
  // the one that decides availability, this one only classifies the request.
  const preview =
    request.nextUrl.searchParams.get("inline") === "1" &&
    isInlineSafe((await readMeta(id))?.mimeType ?? "");

  // A Range rides for free only when it continues a transfer this client already
  // paid for. See registerTransfer: trusting the range itself let `bytes=-<size>`
  // hand out the whole file uncounted.
  const range = request.headers.get("range");
  const resuming = Boolean(range) && isResumedTransfer(id, client);

  const claim = await claimDownload(id, !preview && !resuming);
  if (!claim.ok) {
    if (claim.reason === "not_found") {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
    return NextResponse.json({ error: GONE[claim.reason] }, { status: 410 });
  }
  const meta = claim.meta;

  // Keeps the transfer alive so this client's continuations are recognised as part
  // of the download just counted, and slides forward while it lasts.
  if (!preview) registerTransfer(id, client);

  let size: number;
  try {
    size = (await stat(blobPath(id))).size;
  } catch {
    return NextResponse.json({ error: "File data not found" }, { status: 404 });
  }

  const headers = new Headers({
    "Content-Type": meta.mimeType,
    // Only content that cannot run scripts in our origin is served inline.
    "Content-Disposition": contentDisposition(meta.originalName, preview),
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
    settleWhenOver(partial, claim.done);
    return new NextResponse(Readable.toWeb(partial) as unknown as ReadableStream, {
      status: 206,
      headers,
    });
  }

  // ─── Full transfer ─────────────────────────────────────────────────
  headers.set("Content-Length", String(size));

  const stream = createReadStream(blobPath(id));
  settleWhenOver(stream, claim.done);

  return new NextResponse(Readable.toWeb(stream) as unknown as ReadableStream, {
    status: 200,
    headers,
  });
}

/**
 * `end` means every byte was handed over; `close` without `end` means the
 * client went away first. Only the first counts as a download — and it is
 * what burns the entry when it was the last one allowed. A preview or a
 * continuation carries a no-op `done`, so it can never exhaust anything.
 */
function settleWhenOver(stream: NodeJS.ReadableStream, done: (delivered: boolean) => Promise<void>) {
  let ended = false;
  stream.on("end", () => {
    ended = true;
    void done(true).catch(() => {});
  });
  stream.on("close", () => {
    if (!ended) void done(false).catch(() => {});
  });
}
