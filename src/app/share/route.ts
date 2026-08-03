import { NextRequest, NextResponse } from "next/server";

/**
 * Destino declarado en el manifiesto para el menú "Compartir" del sistema.
 *
 * En condiciones normales esta ruta no llega a ejecutarse: el service worker
 * intercepta el POST, guarda el fichero y redirige a la página. Esto es solo la red
 * de seguridad para cuando el worker todavía no está activo, para que compartir no
 * termine en un 405 sin explicación.
 */
export async function POST(request: NextRequest) {
  return NextResponse.redirect(new URL("/?shared=error", request.url), 303);
}

export async function GET(request: NextRequest) {
  return NextResponse.redirect(new URL("/", request.url), 307);
}
