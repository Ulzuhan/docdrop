import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

const UPLOAD_DIR = join(process.cwd(), ".docdrop-uploads");

// In-memory file metadata store (resets on server restart, files on disk persist)
// For a production app, use a DB — but for this homelab tool, this is perfect
interface FileMeta {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  uploadedAt: number;
  expiresAt: number;
  downloadCount: number;
  maxDownloads: number; // 0 = unlimited
}

const fileStore = new Map<string, FileMeta>();

// Cleanup expired files on startup
async function cleanupExpired() {
  if (!existsSync(UPLOAD_DIR)) return;
  const { readdir, unlink, readFile } = await import("fs/promises");
  const now = Date.now();

  try {
    const dirs = await readdir(UPLOAD_DIR);
    for (const id of dirs) {
      const metaPath = join(UPLOAD_DIR, id, "meta.json");
      try {
        const raw = await readFile(metaPath, "utf-8");
        const meta: FileMeta = JSON.parse(raw);
        if (meta.expiresAt < now || (meta.maxDownloads > 0 && meta.downloadCount >= meta.maxDownloads)) {
          // Expired or max downloads reached — delete
          const filePath = join(UPLOAD_DIR, id, "file");
          try { await unlink(filePath); } catch {}
          try { await unlink(metaPath); } catch {}
          try { await rmdir(join(UPLOAD_DIR, id)); } catch {}
          fileStore.delete(id);
        } else {
          fileStore.set(id, meta);
        }
      } catch {
        // No meta file, try to clean up orphaned dirs
        try { await rmdir(join(UPLOAD_DIR, id)); } catch {}
      }
    }
  } catch {}
}

async function rmdir(path: string) {
  const { rmdir: rmdirFn } = await import("fs/promises");
  return rmdirFn(path);
}

// Run cleanup on module load
cleanupExpired();

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const ttlHours = parseInt(formData.get("ttlHours") as string) || 24;
    const maxDownloads = parseInt(formData.get("maxDownloads") as string) || 0;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    // Max 10GB
    if (file.size > 10 * 1024 * 1024 * 1024) {
      return NextResponse.json({ error: "File too large. Max 10GB." }, { status: 413 });
    }

    const id = randomBytes(6).toString("hex");
    const fileDir = join(UPLOAD_DIR, id);

    // Create directory
    await mkdir(fileDir, { recursive: true });

    // Save file
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(join(fileDir, "file"), buffer);

    // Create metadata
    const meta: FileMeta = {
      id,
      originalName: file.name,
      size: file.size,
      mimeType: file.type || "application/octet-stream",
      uploadedAt: Date.now(),
      expiresAt: Date.now() + ttlHours * 60 * 60 * 1000,
      downloadCount: 0,
      maxDownloads,
    };

    await writeFile(join(fileDir, "meta.json"), JSON.stringify(meta, null, 2));
    fileStore.set(id, meta);

    // Return the shareable link code
    return NextResponse.json({
      id,
      originalName: meta.originalName,
      size: meta.size,
      expiresAt: meta.expiresAt,
      downloadUrl: `/d/${id}`,
    });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}

export async function GET() {
  // List active files (for admin/cleanup purposes)
  const files = Array.from(fileStore.values())
    .filter((f) => f.expiresAt > Date.now())
    .map((f) => ({
      id: f.id,
      originalName: f.originalName,
      size: f.size,
      uploadedAt: f.uploadedAt,
      expiresAt: f.expiresAt,
      downloadCount: f.downloadCount,
    }));
  return NextResponse.json({ files });
}