import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

/**
 * Comprobación OPTIMISTA de sesión: solo mira si existe la cookie, para mandar al
 * login sin pintar el panel. NO es la capa de seguridad — la documentación de Next
 * desaconseja usar el proxy como autorización, y aquí la de verdad la hace
 * requireSession() dentro de cada ruta (que sí valida la firma de la cookie).
 *
 * Rutas públicas: el visor /d/[id] y sus APIs, para que un enlace compartido funcione
 * sin credenciales.
 */
const PUBLIC_PREFIXES = ["/d/", "/api/info/", "/api/download/", "/api/auth/", "/login"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  if (!request.cookies.get(SESSION_COOKIE)?.value) {
    // Las APIs responden 401 en JSON; las páginas redirigen al formulario.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
