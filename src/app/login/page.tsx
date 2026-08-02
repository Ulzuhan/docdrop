"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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
      setError(data.error || "Invalid password");
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
      setPassword("");
    }
  }

  return (
    <div className="flex-1 flex items-center justify-center min-h-[calc(100vh-3.5rem)] px-4">
      <form
        onSubmit={submit}
        className="bg-surface border border-border rounded-2xl p-8 w-full max-w-sm space-y-5"
      >
        <div className="text-center space-y-2">
          <div className="text-4xl">🔒</div>
          <h1 className="text-2xl font-bold">
            <span className="text-accent">Doc</span>Drop
          </h1>
          <p className="text-muted text-sm">Enter the password to upload files.</p>
        </div>

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          autoFocus
          required
          className="w-full bg-surface-light border border-border rounded-xl px-4 py-3 text-foreground outline-none focus:border-accent transition-colors"
          placeholder="Password"
        />

        {error && (
          <p className="text-danger text-sm text-center bg-danger/10 border border-danger/20 rounded-xl p-2.5">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || password.length === 0}
          className="w-full bg-accent hover:bg-accent-hover disabled:opacity-50 text-white font-medium py-3 rounded-xl transition-all active:scale-95"
        >
          {busy ? "Checking…" : "Unlock"}
        </button>

        <p className="text-muted text-xs text-center">
          Anyone with a share link can still download that file without logging in.
        </p>
      </form>
    </div>
  );
}
