import { NextResponse } from "next/server";
import { isAvailable, listMeta } from "@/lib/store";

/**
 * GET /api/files — ficheros activos, del más reciente al más antiguo.
 *
 * Lee siempre del disco, que es la única fuente de verdad; antes /api/upload servía
 * una segunda lista desde una caché en memoria que mostraba contadores obsoletos.
 */
export async function GET() {
  const now = Date.now();
  const files = (await listMeta())
    .filter((meta) => isAvailable(meta, now))
    .sort((a, b) => b.uploadedAt - a.uploadedAt);

  return NextResponse.json({ files });
}
