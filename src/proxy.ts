import { NextRequest, NextResponse } from "next/server";

/**
 * La política de contenido, con un nonce por petición.
 *
 * Antes vivía en `next.config.ts` con `script-src 'self' 'unsafe-inline'`, que
 * es tanto como no tenerla para lo que más importa: `'unsafe-inline'` permite
 * ejecutar cualquier script inyectado en el HTML, que es exactamente el ataque
 * del que una CSP debería proteger. Se llamaba estricta y no lo era.
 *
 * Ahora Next recibe un nonce nuevo en cada petición y lo pone en sus propios
 * scripts en línea; `'strict-dynamic'` deja que esos scripts carguen los suyos.
 * Un `<script>` inyectado no lleva nonce, así que no se ejecuta.
 *
 * Sobre el beacon de analítica: con `'strict-dynamic'` el navegador **ignora la
 * lista de dominios**, así que listarlo no serviría de nada. No hace falta:
 * Cloudflare lo inyecta con el nonce de la página cuando ve uno. Comprobado en
 * vivo antes de escribir esto, en un servicio que ya usaba este mismo patrón.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";

  /**
   * El proveedor de identidad sale de la variable de entorno, no escrito a
   * mano: este repositorio es público y el hostname depende del despliegue.
   *
   * A diferencia de la versión anterior en `next.config.ts`, esto se evalúa en
   * **cada petición**, no en el build. Ya no hay forma de compilar sin el
   * entorno y quedarse con una CSP incompleta sin enterarse.
   */
  const idp = (() => {
    // Del emisor, que es la única dirección del proveedor que se configura
    // desde que los endpoints se descubren (ver lib/oidc.ts). Solo hace falta
    // su origen, así que no se le pregunta nada: esto corre en cada petición
    // y no puede depender de la red.
    const base = process.env.DOCDROP_OIDC_ISSUER?.trim();
    if (!base) return [];
    try {
      return [new URL(base).origin];
    } catch {
      return [];
    }
  })();

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // Los atributos de estilo de los componentes siguen necesitándolo; la
    // ejecución de scripts ya no.
    "style-src 'self' 'unsafe-inline'",
    // `blob:` es para las previsualizaciones de lo que se va a subir.
    "img-src 'self' data: blob:",
    "font-src 'self'",
    ["connect-src 'self'", ...idp, "https://cloudflareinsights.com"].join(" "),
    ["form-action 'self'", ...idp].join(" "),
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      source:
        "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|woff2?)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
