import type { NextConfig } from "next";

/**
 * Security headers. This service may sit behind a plain tunnel with no WAF and no
 * filtering of its own, so whatever protects it has to come from here.
 */
const securityHeaders = [
  // No third-party resources: the app loads nothing external (fonts are
  // self-hosted at build time). 'unsafe-inline' for styles is required by Next.
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
