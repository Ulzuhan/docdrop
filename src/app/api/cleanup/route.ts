import { NextResponse } from "next/server";
import { cleanup } from "@/lib/store";

/**
 * POST /api/cleanup — borra lo caducado, lo agotado y los directorios huérfanos que
 * dejan las subidas interrumpidas. Pensado para un cron.
 */
export async function POST() {
  const deleted = await cleanup();
  return NextResponse.json({ deleted, count: deleted.length, timestamp: Date.now() });
}
