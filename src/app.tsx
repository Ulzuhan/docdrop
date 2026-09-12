import { Footer } from "@/components/footer";
import { ServiceWorkerRegistration } from "@/components/service-worker";
import { Toaster } from "@/components/ui/toaster";
import { Dashboard } from "@/screens/dashboard";
import { DownloadPage } from "@/screens/download";
import { GuestPage } from "@/screens/guest";
import { Landing } from "@/screens/landing";

/**
 * Go composes the document with the session already resolved and leaves in
 * `#app` what the browser cannot work out: which screen, who is signed in,
 * which file or guest link, and the deployment's own URLs. React mounts the
 * screen that corresponds; a direct reload works because the server serves
 * every route.
 */
export function App() {
  const data = document.getElementById("app")?.dataset ?? ({} as DOMStringMap);

  let screen;
  switch (data.page) {
    case "dashboard":
      screen = <Dashboard email={data.email ?? ""} accountUrl={data.accountUrl || null} />;
      break;
    case "download":
      screen = <DownloadPage />;
      break;
    case "guest":
      screen = <GuestPage />;
      break;
    default:
      screen = <Landing enrollUrl={data.enrollUrl?.trim() || null} />;
  }

  return (
    <>
      <div className="canvas" aria-hidden />
      {screen}
      <Footer links={data.footerLinks === "on"} />
      <Toaster />
      <ServiceWorkerRegistration />
    </>
  );
}
