import type { NextConfig } from "next";

/**
 * Security headers. This service may sit behind a plain tunnel with no WAF and no
 * filtering of its own, so whatever protects it has to come from here.
 */
/**
 * La Content-Security-Policy NO está aquí: vive en `src/proxy.ts`, porque
 * necesita un nonce distinto en cada petición y esto se evalúa una sola vez,
 * en el build. Dos cabeceras `Content-Security-Policy` en la misma respuesta
 * se aplican por intersección, así que no puede haber una copia aquí.
 */
const securityHeaders = [
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
