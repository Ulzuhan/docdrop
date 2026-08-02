import { NextResponse } from "next/server";
import { MAX_TOTAL_BYTES, isAvailable, listMeta, usedBytes } from "@/lib/store";
import { requireSession } from "@/lib/auth";

/**
 * GET /api/files — ficheros activos, del más reciente al más antiguo.
 *
 * Lee siempre del disco, que es la única fuente de verdad; antes /api/upload servía
 * una segunda lista desde una caché en memoria que mostraba contadores obsoletos.
 */
export async function GET() {
  // Requiere sesión: esta lista enumera TODOS los enlaces activos, así que dejarla
  // pública equivaldría a publicar todos los ficheros.
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const now = Date.now();
  const files = (await listMeta())
    .filter((meta) => isAvailable(meta, now))
    .sort((a, b) => b.uploadedAt - a.uploadedAt);

  return NextResponse.json({
    files,
    storage: { usedBytes: await usedBytes(), totalBytes: MAX_TOTAL_BYTES },
  });
}
