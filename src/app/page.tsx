import { currentUser } from "@/lib/auth";
import { Dashboard } from "./dashboard";
import { Landing } from "@/components/landing";

/**
 * The front door, decided on the server: a stranger gets the landing page and
 * somebody signed in goes straight to their files. It used to redirect to a
 * login form, which for a stranger is a closed door with no explanation of
 * what is behind it.
 *
 * force-dynamic because this reads the session cookie: prerendering would bake
 * one of the two answers into a static page.
 */
export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await currentUser();
  if (!user) return <Landing />;
  return <Dashboard />;
}
