import { useEffect } from "react";

/**
 * Registers the service worker: what lets a phone install the app, receive
 * files from its "Share" menu, and stream decrypted downloads straight to disk.
 * Browsers only allow it in secure contexts (HTTPS or localhost); elsewhere the
 * app works the same minus those three things.
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
