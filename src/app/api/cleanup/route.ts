import { NextResponse } from "next/server";
import { cleanup } from "@/lib/store";
import { cleanupSessions } from "@/lib/upload-session";
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

  // Primero las subidas por trozos abandonadas: liberan el espacio que tenían
  // reservado y dejan de estar protegidas del barrido general.
  const abandoned = await cleanupSessions();
  const deleted = await cleanup();

  return NextResponse.json({
    deleted,
    abandonedUploads: abandoned,
    count: deleted.length + abandoned.length,
    timestamp: Date.now(),
  });
}
