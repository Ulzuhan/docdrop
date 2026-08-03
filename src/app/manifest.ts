import type { MetadataRoute } from "next";

/**
 * PWA manifest: lets DocDrop be installed on a phone's home screen.
 *
 * `share_target` is what really changes day-to-day use: it makes DocDrop show up in
 * the phone's "Share" menu, so a video can be sent straight from the gallery without
 * opening the browser or hunting for the file.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "DocDrop — Share files",
    short_name: "DocDrop",
    description: "Upload a file, share the link. It self-destructs.",
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
