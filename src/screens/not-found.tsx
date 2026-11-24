import { Compass } from "lucide-react";
import { Header } from "@/components/header";
import { LinkButton } from "@/components/ui/button";

export function NotFoundPage() {
  return (
    <>
      <Header />
      <main className="container-sm dl pb-safe">
        <div className="card state rise">
          <span className="badge" data-tone="danger">
            <Compass aria-hidden />
            404
          </span>
          <h1>Nothing at this address</h1>
          <p>
            The page you asked for does not exist. Shared download links open at{" "}
            <code>/d/…</code>.
          </p>
          <LinkButton href="/" variant="primary">
            Go to DocDrop
          </LinkButton>
        </div>
      </main>
    </>
  );
}
