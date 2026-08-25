"use client";

import { useEffect, useState } from "react";
import { Loader2, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyLinkButton } from "@/components/copy-link-button";
import { formatRemaining } from "@/lib/format";

interface GuestLink {
  token: string;
  label?: string;
  createdAt: number;
  expiresAt: number;
  uploadCount: number;
}

const TTL_OPTIONS = [
  { hours: 1, label: "1 h" },
  { hours: 6, label: "6 h" },
  { hours: 24, label: "1 day" },
  { hours: 72, label: "3 days" },
];

/**
 * Guest link management: mint an upload link for someone without the password,
 * see which links are alive, revoke the ones that should not be.
 */
export function GuestLinksDialog() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-9 text-muted-foreground hover:text-foreground"
          />
        }
      >
        <UserPlus className="size-4" aria-hidden />
        Guest links
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Guest upload links</DialogTitle>
          <DialogDescription>
            Whoever holds one can upload files here — nothing else — until it expires
            or you revoke it.
          </DialogDescription>
        </DialogHeader>
        <GuestLinksPanel />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Lives in its own component so it mounts when the dialog opens: state (and the
 * "now" the countdowns are measured against) starts fresh on every open instead
 * of surviving from page load.
 */
function GuestLinksPanel() {
  const [links, setLinks] = useState<GuestLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [ttl, setTtl] = useState(24);
  const [now, setNow] = useState(() => Date.now());

  // Loaded once per open (the panel remounts with the dialog); create and revoke
  // patch the list locally instead of re-fetching.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/guest-links");
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setLinks(data.links);
      } catch {
        // A network blip must not wipe what is on screen.
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      cancelled = true;
      clearInterval(tick);
    };
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await fetch("/api/guest-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttlHours: ttl, label: label.trim() || undefined }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Could not create the link");
        return;
      }
      const { link } = (await res.json()) as { link: GuestLink };
      setLabel("");
      setLinks((prev) => [link, ...prev]);

      // Handed over right away: creating a link and then hunting for its copy
      // button is the whole flow, so the copy happens here.
      const url = `${window.location.origin}/guest/${link.token}`;
      try {
        await navigator.clipboard.writeText(url);
        toast.success("Guest link created and copied");
      } catch {
        toast.success("Guest link created");
      }
    } catch {
      toast.error("Network error");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(token: string) {
    const res = await fetch(`/api/guest-links/${token}`, { method: "DELETE" }).catch(() => null);
    if (res?.ok) {
      setLinks((prev) => prev.filter((l) => l.token !== token));
      toast.success("Guest link revoked");
    } else {
      toast.error("Could not revoke the link");
    }
  }

  return (
    <>
      <form onSubmit={create} className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="guest-label">For whom (optional)</Label>
          <Input
            id="guest-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Marta"
            maxLength={40}
            className="h-10"
          />
        </div>

        <div className="flex items-end justify-between gap-3">
          <div
            role="radiogroup"
            aria-label="Link lifetime"
            className="grid grid-cols-4 gap-1.5 rounded-xl bg-muted/60 p-1"
          >
            {TTL_OPTIONS.map((option) => (
              <button
                key={option.hours}
                type="button"
                role="radio"
                aria-checked={ttl === option.hours}
                onClick={() => setTtl(option.hours)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-all ${
                  ttl === option.hours
                    ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <Button type="submit" disabled={creating} className="h-9">
            {creating && <Loader2 className="size-4 animate-spin" aria-hidden />}
            Create
          </Button>
        </div>
      </form>

      <div className="mt-2">
        {loading && links.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">Loading…</p>
        ) : links.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border py-4 text-center text-sm text-muted-foreground">
            No active guest links.
          </p>
        ) : (
          <ul className="space-y-2">
            {links.map((link) => (
              <li
                key={link.token}
                className="flex items-center gap-3 rounded-xl border border-border/70 bg-card/60 p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {link.label || "Unnamed link"}
                  </p>
                  <p className="text-xs tabular-nums text-muted-foreground">
                    expires in {formatRemaining(link.expiresAt, now)}
                    {link.uploadCount > 0 &&
                      ` · ${link.uploadCount} upload${link.uploadCount === 1 ? "" : "s"}`}
                  </p>
                </div>
                <CopyLinkButton
                  path={`/guest/${link.token}`}
                  variant="ghost"
                  className="size-9"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-9 text-muted-foreground hover:text-destructive"
                  aria-label={`Revoke ${link.label || "link"}`}
                  onClick={() => revoke(link.token)}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
