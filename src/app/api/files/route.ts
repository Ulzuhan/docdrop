import { NextResponse } from "next/server";
import { MAX_TOTAL_BYTES, isAvailable, listMeta, usedBytes } from "@/lib/store";
import { currentUser, requireSession } from "@/lib/auth";

/**
 * GET /api/files — TUS ficheros activos, los más nuevos primero.
 *
 * «Tus», y esa palabra es el arreglo. Esto listaba todos los ficheros de la
 * instancia a cualquiera con sesión: la herramienta nació como carpeta de un
 * solo operador —la cuenta era la puerta, no el inquilino— y al llegar las
 * cuentas múltiples nadie separó la habitación. El operador lo vio el primer
 * día con un segundo usuario real: el fichero del otro, en su panel, con su
 * enlace de descarga y su botón de borrar.
 *
 * Los ficheros sin dueño (anteriores al campo `owner`) no se enseñan a nadie:
 * su enlace directo sigue siendo válido y la caducidad los retira sola.
 *
 * Always reads from disk, the single source of truth; /api/upload used to serve a
 * second listing from an in-memory cache that showed stale counters.
 */
export async function GET() {
  // Requires a session: this listing enumerates EVERY active link, so leaving it
  // public would be the same as publishing every file.
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const me = await currentUser();
  const mine = `user:${me?.id}`;
  const now = Date.now();
  const files = (await listMeta())
    .filter((meta) => isAvailable(meta, now) && meta.owner === mine)
    .sort((a, b) => b.uploadedAt - a.uploadedAt);

  return NextResponse.json({
    files,
    storage: { usedBytes: await usedBytes(), totalBytes: MAX_TOTAL_BYTES },
    // Kept so the dashboard keeps offering its "log out" button.
    authEnabled: true,
  });
}
