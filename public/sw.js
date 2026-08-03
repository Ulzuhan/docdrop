/**
 * Service worker de DocDrop.
 *
 * Hace dos cosas y nada más:
 *
 *  1. Existe. Un service worker con manejador de fetch es requisito para que el
 *     navegador ofrezca instalar la aplicación.
 *  2. Recoge los ficheros que llegan por el menú "Compartir" del sistema. El
 *     manifiesto declara /share como destino, el sistema envía ahí un POST con el
 *     fichero, y este worker lo guarda un momento y redirige a la página, que lo
 *     recoge y lo sube.
 *
 * A propósito NO cachea la aplicación: es un servicio propio, en red local o tras un
 * túnel, donde servir una versión vieja desde caché causa más problemas de los que
 * resuelve.
 */

const SHARE_CACHE = "docdrop-share";
const SHARE_KEY = "/__shared-file__";

self.addEventListener("install", () => {
  // Activa la versión nueva sin esperar a que se cierren las pestañas antiguas.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Fichero entrante desde el menú "Compartir" del sistema.
  if (event.request.method === "POST" && url.pathname === "/share") {
    event.respondWith(handleShare(event.request));
    return;
  }

  // La página pide el fichero compartido que quedó guardado.
  if (event.request.method === "GET" && url.pathname === SHARE_KEY) {
    event.respondWith(
      caches
        .open(SHARE_CACHE)
        .then((cache) => cache.match(SHARE_KEY))
        .then((hit) => hit || new Response(null, { status: 404 }))
    );
    return;
  }

  // Todo lo demás va a la red sin intermediarios.
});

async function handleShare(request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (file && typeof file !== "string") {
      const cache = await caches.open(SHARE_CACHE);
      await cache.put(
        SHARE_KEY,
        new Response(file, {
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            // El nombre viaja aparte: el cuerpo de una Response no lo conserva.
            "X-Shared-Filename": encodeURIComponent(file.name || "compartido"),
          },
        })
      );
      return Response.redirect("/?shared=1", 303);
    }
  } catch (error) {
    console.error("[docdrop sw] fallo al recibir el fichero compartido", error);
  }

  return Response.redirect("/?shared=error", 303);
}
