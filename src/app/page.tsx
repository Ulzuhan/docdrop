import { redirect } from "next/navigation";
import { hasSession } from "@/lib/auth";
import { Dashboard } from "./dashboard";

/**
 * Server gate for the dashboard. Without it the client page painted the whole
 * upload UI, asked /api/files, got the 401 and only then bounced to /login — an
 * ugly flash of a screen the visitor was never going to keep.
 *
 * This is presentation, not enforcement: every API route still checks the
 * session itself (see lib/auth.ts). With no password configured hasSession()
 * is always true and the service stays open, as before.
 */
// Without this the page prerenders at build time, where the credentials env is
// not loaded: authRequired() answers false, the open branch gets baked into the
// static page and the gate never runs. The check must happen per request.
export const dynamic = "force-dynamic";

export default async function Home() {
  if (!(await hasSession())) redirect("/login");
  return <Dashboard />;
}
