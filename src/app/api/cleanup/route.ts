import { NextResponse } from "next/server";
import { cleanup } from "@/lib/store";
import { requireSession } from "@/lib/auth";

/**
 * POST /api/cleanup — borra lo caducado, lo agotado y los directorios huérfanos que
 * dejan las subidas interrumpidas.
 *
 * Requiere sesión: abierto permitiría a cualquiera forzar purgas.
 * Para un cron, autentícalo con la cookie de sesión o llama directamente a cleanup().
 */
export async function POST() {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const deleted = await cleanup();
  return NextResponse.json({ deleted, count: deleted.length, timestamp: Date.now() });
}
