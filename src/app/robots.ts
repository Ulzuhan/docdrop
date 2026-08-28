import type { MetadataRoute } from "next";

/**
 * Se evalúa en cada petición, y no es opcional: estas rutas son Route Handlers
 * que Next cachea en la construcción por defecto, y la construcción ocurre en
 * CI, donde el origen público NO existe — el sitemap salía vacío y a robots le
 * faltaba su línea Sitemap. Medido antes de publicar nada.
 */
export const dynamic = "force-dynamic";

/**
 * `/d/` and `/guest/` are disallowed because the identifier in those URLs is
 * the credential — 72 random bits that grant a download, or a token that grants
 * an upload. The front page, which explains the product, is the only thing here
 * worth indexing.
 */
export default function robots(): MetadataRoute.Robots {
  const host = process.env.DOCDROP_PUBLIC_HOST?.trim();
  const base = host ? `https://${host}` : undefined;
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/d/", "/guest/", "/api/", "/share"] },
    ...(base ? { sitemap: `${base}/sitemap.xml`, host: base } : {}),
  };
}
