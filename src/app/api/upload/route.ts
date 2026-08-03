import { NextRequest, NextResponse } from "next/server";
import { createWriteStream } from "fs";
import { stat } from "fs/promises";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "stream/web";
import {
  MAX_FILE_SIZE,
  MAX_TOTAL_BYTES,
  blobPath,
  clampMaxDownloads,
  clampTtlHours,
  createEntryDir,
  deleteEntry,
  generateId,
  sanitizeFilename,
  sanitizeUploader,
  usedBytes,
  writeMeta,
  type FileMeta,
} from "@/lib/store";
import { requireSession } from "@/lib/auth";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/ratelimit";

/**
 * POST /api/upload — the request body IS the file (not multipart).
 *
 * Metadata travels in headers:
 *   x-filename       original name, percent-encoded (UTF-8)
 *   x-ttl-hours      hours until self-destruction (1..720)
 *   x-max-downloads  0 = unlimited
 *   x-uploaded-by    optional uploader label, percent-encoded
 *
 * This used to call request.formData(), which materialises the whole file in memory:
 * with the advertised 10 GB limit the process died long before getting there (Node's
 * Buffer cap is around 2 GB). The body is now streamed to disk, so memory usage is
 * constant and independent of the file size.
 */
export async function POST(request: NextRequest) {
  // Uploading requires a session: exposed to the internet, an open upload endpoint
  // is free anonymous hosting and a trivial way to fill the disk.
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const limit = rateLimit(`upload:${clientIp(request)}`, 30, 60 * 60 * 1000);
  if (!limit.allowed) return tooManyRequests(limit);

  if (!request.body) {
    return NextResponse.json({ error: "Empty request body" }, { status: 400 });
  }

  const rawName = request.headers.get("x-filename");
  if (!rawName) {
    return NextResponse.json({ error: "Missing x-filename header" }, { status: 400 });
  }

  let originalName: string;
  try {
    originalName = sanitizeFilename(decodeURIComponent(rawName));
  } catch {
    return NextResponse.json({ error: "Malformed x-filename header" }, { status: 400 });
  }

  const ttlHours = clampTtlHours(request.headers.get("x-ttl-hours"));
  const maxDownloads = clampMaxDownloads(request.headers.get("x-max-downloads"));

  // Early rejection when the client already declares an excessive size, so we do
  // not write gigabytes to disk before noticing.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_FILE_SIZE) {
    return NextResponse.json({ error: "File too large. Max 10GB." }, { status: 413 });
  }

  // Global quota: stops the store from growing until it fills the machine disk and
  // takes every other service on the box down with it.
  const used = await usedBytes();
  const budget = MAX_TOTAL_BYTES - used;
  if (budget <= 0) {
    return NextResponse.json(
      { error: "Storage full. Delete or wait for files to expire." },
      { status: 507 }
    );
  }
  if (Number.isFinite(declared) && declared > budget) {
    return NextResponse.json(
      { error: "Not enough storage left for this file." },
      { status: 507 }
    );
  }

  // The real cut-off applies to what actually arrives, not to what was declared.
  const hardCap = Math.min(MAX_FILE_SIZE, budget);

  const id = generateId();

  try {
    await createEntryDir(id);

    // Aborts as soon as the limit is exceeded, even if the client lied in
    // Content-Length or sent none at all.
    let written = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        written += chunk.length;
        if (written > hardCap) {
          cb(Object.assign(new Error("File too large"), { code: "TOO_LARGE" }));
          return;
        }
        cb(null, chunk);
      },
    });

    const source = Readable.fromWeb(request.body as unknown as NodeWebReadableStream);
    await pipeline(source, limiter, createWriteStream(blobPath(id)));

    if (written === 0) {
      await deleteEntry(id);
      return NextResponse.json({ error: "Empty file" }, { status: 400 });
    }

    // The size comes from disk, not from whatever the client claimed.
    const size = (await stat(blobPath(id))).size;

    const now = Date.now();
    const meta: FileMeta = {
      id,
      originalName,
      size,
      mimeType: request.headers.get("content-type") || "application/octet-stream",
      uploadedAt: now,
      expiresAt: now + ttlHours * 60 * 60 * 1000,
      downloadCount: 0,
      maxDownloads,
      uploadedBy: sanitizeUploader(
        request.headers.get("x-uploaded-by")
          ? decodeURIComponent(request.headers.get("x-uploaded-by")!)
          : undefined
      ),
    };
    await writeMeta(meta);

    return NextResponse.json({
      id,
      originalName: meta.originalName,
      size: meta.size,
      expiresAt: meta.expiresAt,
      maxDownloads: meta.maxDownloads,
      downloadUrl: `/d/${id}`,
    });
  } catch (error) {
    // Without this, an interrupted upload left a half-written directory forever.
    await deleteEntry(id).catch(() => {});

    if ((error as { code?: string }).code === "TOO_LARGE") {
      return NextResponse.json({ error: "File too large. Max 10GB." }, { status: 413 });
    }
    console.error("Upload error:", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
