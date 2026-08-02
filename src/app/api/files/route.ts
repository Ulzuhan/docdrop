import { NextResponse } from "next/server";
import { readdir, readFile, stat } from "fs/promises";
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

export async function GET() {
  const now = Date.now();
  const files: FileMeta[] = [];

  try {
    const dirs = await readdir(UPLOAD_DIR);
    for (const id of dirs) {
      try {
        const raw = await readFile(join(UPLOAD_DIR, id, "meta.json"), "utf-8");
        const meta: FileMeta = JSON.parse(raw);

        // Only list non-expired files
        if (meta.expiresAt > now) {
          // Also check max downloads
          if (meta.maxDownloads === 0 || meta.downloadCount < meta.maxDownloads) {
            files.push(meta);
          }
        }
      } catch {
        // Skip malformed entries
      }
    }
  } catch {
    // Upload dir doesn't exist yet
  }

  // Sort by newest first
  files.sort((a, b) => b.uploadedAt - a.uploadedAt);

  return NextResponse.json({ files });
}