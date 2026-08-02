import type { NextConfig } from "next";

/**
 * Cabeceras de seguridad. Este servicio se publica en internet con Tailscale Funnel,
 * que no aporta WAF ni filtrado: todo lo que proteja tiene que salir de aquí.
 */
const securityHeaders = [
  // Sin recursos de terceros: la app no carga nada externo (las fuentes se
  // autoalojan en el build). 'unsafe-inline' en estilos lo exige Next.
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "upgrade-insecure-requests",
    ].join("; "),
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // Un año de HSTS: en Funnel el acceso siempre es HTTPS.
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  // `serverExternalPackages` sirve para excluir dependencias npm del bundling; listar
  // ahí módulos nativos ("fs", "path", "crypto") no hacía nada, y menos aún subir el
  // límite de subida. El tamaño lo controla /api/upload, que escribe por streaming.

  // Fija la raíz del workspace: hay un package.json suelto en el home que hacía que
  // Next infiriera mal la raíz y avisara en cada build.
  turbopack: {
    root: __dirname,
  },

  // No anunciar la tecnología del servidor a quien escanee.
  poweredByHeader: false,

  // Empaquetado autónomo: en producción se despliega solo .next/standalone, sin código
  // fuente ni dependencias de desarrollo. Menos superficie que copiar el proyecto entero.
  output: "standalone",

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
