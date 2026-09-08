/**
 * El punto de entrada del navegador.
 *
 * Go compone el documento con la sesión ya resuelta y deja en `#app` lo que el
 * navegador no puede deducir: qué pantalla toca, quién ha entrado, qué fichero
 * se está mirando y los límites del almacén. React monta la pantalla que
 * corresponda; las rutas siguen siendo las de siempre y una recarga directa
 * funciona porque el servidor las sirve.
 *
 * El cifrado de punta a punta NO pasa por aquí: vive donde vivía, en
 * `src/lib/e2ee.ts`, y lo importan las mismas pantallas. Este port no lo toca.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";

import "./styles/fuentes.css";
import "./styles/globals.css";

import { KaiCorpFooter } from "@/components/kaicorp-footer";
import { ServiceWorkerRegistration } from "@/components/service-worker";
import { Landing } from "@/components/landing";
import { Dashboard } from "@/screens/dashboard";
import DownloadPage from "@/screens/download";
import GuestPage from "@/screens/guest";

const raiz = document.getElementById("app");
const datos = raiz?.dataset ?? ({} as DOMStringMap);

function Pantalla() {
  switch (datos.page) {
    case "dashboard":
      return <Dashboard email={datos.email ?? ""} accountUrl={datos.accountUrl ?? null} />;
    case "download":
      return <DownloadPage />;
    case "guest":
      return <GuestPage />;
    default:
      return <Landing />;
  }
}

function App() {
  return (
    // El nonce no hace falta aquí: el script antiparpadeo lo pone Go en el
    // documento, con el nonce de esa respuesta, y ya ha corrido antes de que
    // esto monte. next-themes sólo tiene que ponerse de acuerdo con lo que ya
    // hay puesto, y usa la misma clave de almacenamiento.
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <Pantalla />
      <KaiCorpFooter current="docdrop" />
      <Toaster position="top-center" richColors closeButton />
      <ServiceWorkerRegistration />
    </ThemeProvider>
  );
}

if (raiz) {
  createRoot(raiz).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
