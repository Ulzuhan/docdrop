import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const raw = await readFile(join(UPLOAD_DIR, id, "meta.json"), "utf-8");
    const meta: FileMeta = JSON.parse(raw);

    if (meta.expiresAt < Date.now()) {
      return NextResponse.json({ error: "File expired" }, { status: 410 });
    }

    if (meta.maxDownloads > 0 && meta.downloadCount >= meta.maxDownloads) {
      return NextResponse.json({ error: "Max downloads reached" }, { status: 410 });
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
    });
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}