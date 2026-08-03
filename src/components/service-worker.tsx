"use client";

import { useEffect } from "react";

/**
 * Registers the service worker, required for the phone to offer installing the app
 * and for receiving files from the "Share" menu.
 *
 * Browsers only allow this in secure contexts: HTTPS or localhost. Over plain HTTP
 * on a local IP it will not register, and the app keeps working the same except for
 * installation.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("[docdrop] could not register the service worker:", error);
    });
  }, []);

  return null;
}
