import type { NextConfig } from "next";

/**
 * Security headers. This service may sit behind a plain tunnel with no WAF and no
 * filtering of its own, so whatever protects it has to come from here.
 */
/**
 * El proveedor de identidad, si lo hay, sale de la misma variable que ya usa el
 * arranque OIDC. No se escribe a mano aquí: este repositorio es público y el
 * hostname depende de cada despliegue. Sin esto, `connect-src 'self'` bloquea la
 * ida al proveedor y el navegador registra una violación en cada carga — no
 * rompe el login, que es un 302 de servidor y la CSP no gobierna, pero deja
 * ruido permanente en la consola que acaba tapando un problema de verdad.
 *
 * OJO: esto se evalúa **en el build**, no al arrancar. Hay que compilar con el
 * mismo entorno con el que corre el servicio; si no, `idp` sale vacío y la CSP
 * pierde el proveedor sin decir nada. En systemd el entorno llega por
 * EnvironmentFile, así que un `npm run build` a pelo desde otra shell NO basta:
 *   set -a; . ~/.docdrop.env; . ~/.docdrop-oidc.env; set +a; npm run build
 */
const idp = (() => {
  const base = process.env.DOCDROP_OIDC_PUBLIC_BASE?.trim();
  if (!base) return [];
  try {
    return [new URL(base).origin];
  } catch {
    return [];
  }
})();

/** Beacon de analítica de Cloudflare: lo inyecta el borde, no la aplicación. */
const beacon = "https://static.cloudflareinsights.com";

const securityHeaders = [
  // Nada de terceros salvo lo listado: las tipografías se autoalojan en el build.
  // 'unsafe-inline' en estilos lo exige Next.
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline' ${beacon}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      ["connect-src 'self'", ...idp, "https://cloudflareinsights.com"].join(" "),
      "object-src 'none'",
      "base-uri 'none'",
      ["form-action 'self'", ...idp].join(" "),
      "frame-ancestors 'none'",
      "upgrade-insecure-requests",
    ].join("; "),
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // One year of HSTS: behind a tunnel access is always HTTPS.
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  // Note: `serverExternalPackages` excludes npm dependencies from bundling. Listing
  // native modules ("fs", "path", "crypto") there does nothing at all, and certainly
  // does not raise any upload limit — size is enforced by /api/upload, which streams.

  // Pins the workspace root to this directory. Without it, a stray lockfile higher
  // up the tree makes Next infer the wrong root and trace far more than it should.
  // A relative path avoids the filesystem call that would pull the config into the
  // trace itself.
  turbopack: {
    root: ".",
  },

  // Do not advertise the server technology to whoever scans it.
  poweredByHeader: false,

  // Standalone output: production deploys only .next/standalone, with no source and
  // no dev dependencies. Less surface than copying the whole project.
  output: "standalone",

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
