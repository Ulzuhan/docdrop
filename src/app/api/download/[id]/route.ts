import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";

const UPLOAD_DIR = join(process.cwd(), ".docdrop-uploads");

interface FileMeta {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  uploadedAt: number;
  expiresAt: number;
  downloadCount: number;
  maxDownloads: number;
}

function getFileStore(): Map<string, FileMeta> {
  if (!(globalThis as any).__docdrop_store__) {
    (globalThis as any).__docdrop_store__ = new Map();
  }
  return (globalThis as any).__docdrop_store__;
}

async function loadMeta(id: string): Promise<FileMeta | null> {
  const fileStore = getFileStore();
  if (fileStore.has(id)) return fileStore.get(id)!;

  try {
    const raw = await readFile(join(UPLOAD_DIR, id, "meta.json"), "utf-8");
    const parsed: FileMeta = JSON.parse(raw);
    fileStore.set(id, parsed);
    return parsed;
  } catch {
    return null;
  }
}

async function deleteFile(id: string) {
  const { unlink, rmdir } = await import("fs/promises");
  try { await unlink(join(UPLOAD_DIR, id, "file")); } catch {}
  try { await unlink(join(UPLOAD_DIR, id, "meta.json")); } catch {}
  try { await rmdir(join(UPLOAD_DIR, id)); } catch {}
  getFileStore().delete(id);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const meta = await loadMeta(id);

  if (!meta) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  // Check expiry
  if (meta.expiresAt < Date.now()) {
    await deleteFile(id);
    return NextResponse.json({ error: "File expired" }, { status: 410 });
  }

  // Check max downloads
  if (meta.maxDownloads > 0 && meta.downloadCount >= meta.maxDownloads) {
    await deleteFile(id);
    return NextResponse.json({ error: "Max downloads reached" }, { status: 410 });
  }

  // Increment download count
  meta.downloadCount++;
  await writeFile(join(UPLOAD_DIR, id, "meta.json"), JSON.stringify(meta, null, 2));

  // Stream the file
  try {
    const fileBuffer = await readFile(join(UPLOAD_DIR, id, "file"));

    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        "Content-Type": meta.mimeType,
        "Content-Disposition": `attachment; filename="${encodeURIComponent(meta.originalName)}"`,
        "Content-Length": String(meta.size),
      },
    });
  } catch {
    return NextResponse.json({ error: "File data not found" }, { status: 404 });
  }
}