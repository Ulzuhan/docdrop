/**
 * DocDrop service worker.
 *
 * It does three things and nothing else:
 *
 *  1. It exists. A service worker with a fetch handler is a requirement for the
 *     browser to offer installing the app.
 *  2. It picks up files arriving from the system "Share" menu. The manifest declares
 *     /share as the target, the system POSTs the file there, and this worker stores
 *     it briefly and redirects to the page, which picks it up and uploads it.
 *  3. Convierte un stream de la página en una DESCARGA NATIVA del navegador — la
 *     pieza que permite descifrar ficheros de gigas hacia el disco sin tenerlos
 *     en memoria (kaicorplabs/docs/24, F2). La página descifra trozo a trozo y
 *     este worker los sirve como respuesta de una URL de descarga; el navegador
 *     los va escribiendo a disco con su propia barra de progreso.
 *
 * It deliberately does NOT cache the app: this is a self-hosted service on a local
 * network or behind a tunnel, where serving a stale version from cache causes more
 * problems than it solves.
 */

const SHARE_CACHE = "docdrop-share";
const SHARE_KEY = "/__shared-file__";

/**
 * Descargas en vuelo: token → { port, nombre, tamano }.
 *
 * La página anuncia una descarga por postMessage con un puerto; cuando el
 * navegador pide /descarga-local/<token>, la respuesta es un stream que TIRA de
 * ese puerto: el worker manda {pide} y la página contesta {bytes} — un trozo en
 * vuelo como mucho, que es la contrapresión. Si la red descifra más rápido de
 * lo que el disco escribe, la página simplemente espera al siguiente {pide}.
 */
const DESCARGAS = new Map();

self.addEventListener("message", (event) => {
  const datos = event.data;
  if (!datos || datos.tipo !== "docdrop-descarga") return;
  DESCARGAS.set(datos.token, {
    port: event.ports[0],
    nombre: String(datos.nombre || "download"),
    tamano: Number(datos.tamano) || 0,
  });
  // El "listo": sin él, la página podría navegar el iframe antes de que este
  // mensaje se procese y la descarga naciente daría 404.
  event.ports[0].postMessage({ tipo: "listo" });
});

function respuestaDeDescarga(entrada) {
  const { port, nombre, tamano } = entrada;
  let resolverPendiente = null;

  port.onmessage = (event) => {
    const m = event.data;
    if (!resolverPendiente) return;
    const resolver = resolverPendiente;
    resolverPendiente = null;
    resolver(m);
  };

  const cuerpo = new ReadableStream({
    pull(controlador) {
      return new Promise((resolver) => {
        resolverPendiente = (m) => {
          if (m.tipo === "bytes") controlador.enqueue(new Uint8Array(m.bytes));
          else if (m.tipo === "fin") controlador.close();
          else controlador.error(new Error(m.motivo || "stream error"));
          resolver();
        };
        port.postMessage({ tipo: "pide" });
      });
    },
    cancel() {
      // El navegador canceló la descarga: que la página deje de descifrar.
      try {
        port.postMessage({ tipo: "cancelado" });
      } catch {
        /* el puerto puede haberse ido con la página */
      }
    },
  });

  const cabeceras = {
    "Content-Type": "application/octet-stream",
    // filename* con UTF-8: el nombre de verdad sale del descifrado en la página
    // y puede llevar cualquier cosa.
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(nombre)}`,
    "X-Content-Type-Options": "nosniff",
  };
  // Con el tamaño en claro (viene de la cabecera cifrada), el navegador enseña
  // progreso de verdad en su propia interfaz de descargas.
  if (tamano > 0) cabeceras["Content-Length"] = String(tamano);

  return new Response(cuerpo, { headers: cabeceras });
}

self.addEventListener("install", () => {
  // Activate the new version without waiting for old tabs to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Incoming file from the system "Share" menu.
  if (event.request.method === "POST" && url.pathname === "/share") {
    event.respondWith(handleShare(event.request));
    return;
  }

  // The page asks for the shared file that was stored.
  if (event.request.method === "GET" && url.pathname === SHARE_KEY) {
    event.respondWith(
      caches
        .open(SHARE_CACHE)
        .then((cache) => cache.match(SHARE_KEY))
        .then((hit) => hit || new Response(null, { status: 404 }))
    );
    return;
  }

  // Una descarga anunciada por la página: servirla desde su puerto.
  if (event.request.method === "GET" && url.pathname.startsWith("/descarga-local/")) {
    const token = url.pathname.slice("/descarga-local/".length);
    const entrada = DESCARGAS.get(token);
    DESCARGAS.delete(token);
    event.respondWith(entrada ? respuestaDeDescarga(entrada) : new Response(null, { status: 404 }));
    return;
  }

  // Everything else goes straight to the network.
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
            // The name travels separately: a Response body does not carry it.
            "X-Shared-Filename": encodeURIComponent(file.name || "shared"),
          },
        })
      );
      return Response.redirect("/?shared=1", 303);
    }
  } catch (error) {
    console.error("[docdrop sw] failed to receive the shared file", error);
  }

  return Response.redirect("/?shared=error", 303);
}
