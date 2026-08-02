import { NextResponse } from "next/server";
import { readdir, readFile, unlink, rmdir } from "fs/promises";
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

export async function POST() {
  // Cleanup endpoint — can be called via cron or manually
  // Deletes expired files and files that reached max downloads
  const now = Date.now();
  const deleted: string[] = [];
  const errors: string[] = [];

  try {
    if (!(await exists(UPLOAD_DIR))) {
      return NextResponse.json({ deleted: [], errors: [] });
    }

    const dirs = await readdir(UPLOAD_DIR);
    for (const id of dirs) {
      try {
        const raw = await readFile(join(UPLOAD_DIR, id, "meta.json"), "utf-8");
        const meta: FileMeta = JSON.parse(raw);

        const isExpired = meta.expiresAt < now;
        const isMaxed = meta.maxDownloads > 0 && meta.downloadCount >= meta.maxDownloads;

        if (isExpired || isMaxed) {
          try { await unlink(join(UPLOAD_DIR, id, "file")); } catch {}
          try { await unlink(join(UPLOAD_DIR, id, "meta.json")); } catch {}
          try { await rmdir(join(UPLOAD_DIR, id)); } catch {}
          deleted.push(id);
        }
      } catch {
        // Orphaned dir, try to remove
        try { await rmdir(join(UPLOAD_DIR, id)); } catch {}
        errors.push(id);
      }
    }
  } catch (e: any) {
    errors.push(e.message);
  }

  return NextResponse.json({ deleted, errors, timestamp: now });
}

async function exists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}