import { NextResponse } from "next/server";
import { endSession } from "@/lib/auth";
import { endSessionUrl, oidcConfig } from "@/lib/oidc";

/**
 * POST /api/auth/logout — cierra la sesión de verdad.
 *
 * Borrar la cookie de aquí no bastaba: la sesión del proveedor seguía viva, así
 * que pulsar "Sign in" volvía a entrar SIN pedir usuario ni contraseña.
 * Comprobado en vivo antes de cambiarlo. En un ordenador compartido eso es peor
 * que no tener botón: quien lo pulsa cree que ha salido y el siguiente entra en
 * su cuenta.
 *
 * Así que además se devuelve el `end-session` del proveedor, y el navegador va
 * allí. No echa a nadie de las otras aplicaciones abiertas —cada una tiene su
 * propia sesión, independiente de la de Authentik— pero a partir de aquí
 * cualquier entrada vuelve a pedir credenciales, que es lo que la gente espera
 * de un botón que dice "Sign out".
 *
 * Sigue siendo POST y no GET: con GET, una imagen en cualquier página podría
 * cerrarte la sesión desde fuera.
 */
export async function POST() {
  await endSession();

  const cfg = oidcConfig();
  // El usuario acaba en la pantalla de entrada de KaiCorp Labs; el porqué de no
  // devolverlo aquí está explicado en `endSessionUrl`.
  const next = cfg ? endSessionUrl(cfg) : "/";

  return NextResponse.json({ ok: true, next });
}
