"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SiteHeader } from "@/components/site-header";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.replace("/");
        router.refresh();
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Contraseña incorrecta");
      setPassword("");
    } catch {
      setError("Error de red");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SiteHeader />

      <main className="mx-auto flex w-full max-w-sm flex-1 items-center justify-center px-4 py-10 pb-safe">
        <form onSubmit={submit} className="w-full rounded-2xl border border-border bg-card/70 p-6 sm:p-8">
          <div className="text-center">
            <span
              aria-hidden
              className="mx-auto grid size-14 place-items-center rounded-2xl bg-primary/12 text-primary ring-1 ring-primary/20"
            >
              <Lock className="size-6" />
            </span>
            <h1 className="mt-4 text-xl font-semibold tracking-tight">Acceso restringido</h1>
            <p className="mt-1.5 text-sm text-muted-foreground text-balance">
              Introduce la contraseña para subir y gestionar ficheros.
            </p>
          </div>

          <div className="mt-6 space-y-2">
            <Label htmlFor="password">Contraseña</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              autoFocus
              required
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "login-error" : undefined}
              className="h-11"
            />
          </div>

          {error && (
            <p
              id="login-error"
              role="alert"
              className="mt-3 rounded-xl border border-destructive/25 bg-destructive/5 p-2.5 text-center text-sm text-destructive"
            >
              {error}
            </p>
          )}

          <Button type="submit" disabled={busy || !password} className="mt-5 h-11 w-full">
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {busy ? "Comprobando…" : "Entrar"}
          </Button>

          <p className="mt-5 text-center text-xs text-muted-foreground text-balance">
            Quien tenga un enlace de descarga puede seguir bajando ese fichero sin entrar.
          </p>
        </form>
      </main>
    </>
  );
}
