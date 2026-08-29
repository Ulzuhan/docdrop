import { NextResponse } from "next/server";
import { verificarCierre } from "@/lib/backchannel";
import { oidcConfig } from "@/lib/oidc";
import { revocar } from "@/lib/revocaciones";
import { findBySub } from "@/lib/users";

/**
 * Donde el proveedor avisa de que una sesión suya ha terminado.
 *
 * La llama el PROVEEDOR, servidor a servidor — nunca un navegador —, así que
 * aquí no hay cookies, ni CSRF, ni origen que comprobar: lo único que autentica
 * esta petición es la firma del `logout_token`, y de eso se encarga
 * `verificarCierre`.
 *
 * Como la sesión de aquí es una cookie firmada y no vive en el servidor, no hay
 * nada que borrar: se anota a esa persona en la lista de revocación, y a partir
 * de ese instante sus cookies dejan de valer. Visto desde fuera es idéntico a
 * lo que hacen las herramientas que sí guardan sesiones.
 *
 * Los códigos son los que espera la especificación: 200 si se ha atendido, 400
 * si el token no vale. Nada de 401/403, que harían que el proveedor reintentara
 * eternamente algo que nunca va a mejorar.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const cfg = oidcConfig();
  if (!cfg) return NextResponse.json({ error: "not_configured" }, { status: 404 });

  const tipo = request.headers.get("content-type") ?? "";
  if (!tipo.includes("application/x-www-form-urlencoded")) {
    return NextResponse.json({ error: "unsupported_media_type" }, { status: 400 });
  }

  let token: string | null = null;
  try {
    token = new URLSearchParams(await request.text()).get("logout_token");
  } catch {
    token = null;
  }
  if (!token) return NextResponse.json({ error: "missing logout_token" }, { status: 400 });

  let aviso;
  try {
    aviso = await verificarCierre(token, cfg);
  } catch {
    // No se ha podido hablar con el proveedor para comprobar la firma: eso es
    // un fallo nuestro y sí merece que lo reintente.
    return NextResponse.json({ error: "verification unavailable" }, { status: 503 });
  }
  if (!aviso) return NextResponse.json({ error: "invalid logout_token" }, { status: 400 });

  if (aviso.sub) {
    // La cookie de aquí nombra al usuario por su id interno, no por el `sub`
    // del proveedor, así que la lista se lleva por ese id: es lo que se puede
    // comprobar al leer una cookie sin ir a buscar nada.
    const persona = await findBySub(aviso.sub);
    if (persona) {
      try {
        revocar(persona.id);
      } catch {
        // Si no se puede escribir la lista, la revocación NO ha ocurrido.
        // Decirlo, para que el proveedor lo reintente: perderla en silencio
        // sería dejar dentro a quien se acaba de echar.
        return NextResponse.json({ error: "could not record revocation" }, { status: 503 });
      }
    }
  }

  return NextResponse.json({ ok: true });
}
