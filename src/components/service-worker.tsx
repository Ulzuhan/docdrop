"use client";

import { useEffect } from "react";

/**
 * Registra el service worker, necesario para que el móvil ofrezca instalar la
 * aplicación y para recibir ficheros desde el menú "Compartir".
 *
 * Los navegadores solo lo permiten en contextos seguros: HTTPS o localhost. En una
 * IP de red local por HTTP no se registrará, y la aplicación seguirá funcionando
 * igual salvo por la instalación.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("[docdrop] no se pudo registrar el service worker:", error);
    });
  }, []);

  return null;
}
