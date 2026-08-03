import type { MetadataRoute } from "next";

/**
 * Manifiesto de la PWA: permite instalar DocDrop en la pantalla de inicio del móvil.
 *
 * `share_target` es lo que de verdad cambia el uso diario: hace que DocDrop aparezca
 * en el menú "Compartir" del móvil, así que se puede enviar un vídeo desde la galería
 * sin pasar por el navegador ni buscar el fichero a mano.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "DocDrop — Comparte ficheros",
    short_name: "DocDrop",
    description: "Sube un fichero, comparte el enlace. Se autodestruye.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#16161f",
    theme_color: "#16161f",
    categories: ["utilities", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    share_target: {
      action: "/share",
      method: "POST",
      enctype: "multipart/form-data",
      params: {
        files: [{ name: "file", accept: ["*/*"] }],
      },
    },
  };
}
