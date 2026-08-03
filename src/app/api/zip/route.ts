import { NextRequest, NextResponse } from "next/server";
import { Readable } from "stream";
import { blobPath, claimDownload, contentDisposition, isValidId } from "@/lib/store";
import { createZipStream, uniqueNames, type ZipEntry } from "@/lib/zip";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/ratelimit";

/** Cap on files per archive, so one URL cannot trigger an outsized download. */
const MAX_ENTRIES = 100;

/**
 * GET /api/zip?ids=a,b,c[&name=trip] — downloads several files as a single archive.
 *
 * Public, like individual downloads: whoever holds the links can group them. It is
 * streamed and uncompressed, so it starts downloading immediately and needs no
 * temporary space on the server.
 *
 * Every included file counts as a download of its own. Files that are no longer
 * available are skipped silently rather than failing the whole archive: getting 9
 * out of 10 videos beats getting an error.
 */
export async function GET(request: NextRequest) {
  const limit = rateLimit(`zip:${clientIp(request)}`, 30, 60_000);
  if (!limit.allowed) return tooManyRequests(limit);

  const raw = request.nextUrl.searchParams.get("ids") ?? "";
  const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];

  if (ids.length === 0) {
    return NextResponse.json({ error: "No ids" }, { status: 400 });
  }
  if (ids.length > MAX_ENTRIES) {
    return NextResponse.json(
      { error: `Too many files (max ${MAX_ENTRIES})` },
      { status: 400 }
    );
  }
  if (ids.some((id) => !isValidId(id))) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  // Downloads are claimed up front, so the counter reflects what is actually going
  // to be sent and per-file limits are respected.
  const entries: ZipEntry[] = [];
  for (const id of ids) {
    const claim = await claimDownload(id);
    if (!claim.ok) continue;
    entries.push({
      name: claim.meta.originalName,
      path: blobPath(id),
      size: claim.meta.size,
      mtime: new Date(claim.meta.uploadedAt),
    });
  }

  if (entries.length === 0) {
    return NextResponse.json(
      { error: "None of those files are available any more" },
      { status: 410 }
    );
  }

  // Two files may share a name; inside the archive they cannot.
  const names = uniqueNames(entries.map((e) => e.name));
  entries.forEach((entry, i) => {
    entry.name = names[i];
  });

  const requested = request.nextUrl.searchParams.get("name")?.trim();
  const base = requested && /^[\w \-.]{1,60}$/.test(requested) ? requested : "docdrop";
  const stamp = new Date().toISOString().slice(0, 10);

  const zip = createZipStream(entries);

  return new NextResponse(Readable.toWeb(zip) as unknown as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      // No Content-Length: the final size is unknown until generation finishes.
      "Content-Disposition": contentDisposition(`${base}-${stamp}.zip`),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}
