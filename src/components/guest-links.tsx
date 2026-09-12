import { useEffect, useState, type FormEvent } from "react";
import { Hourglass, Inbox, Loader, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { LinkBox } from "@/components/link-box";
import { CopyLinkButton, absoluteUrl } from "@/components/link-actions";
import { TTL_OPTIONS } from "@/components/upload-options";
import { createGuestLink, fetchGuestLinks, revokeGuestLink, type GuestLink } from "@/lib/api";
import { formatRemaining, plural } from "@/lib/format";
import { toast } from "@/lib/toast";
import { useNow } from "@/lib/use-now";

/**
 * Guest links: mint an upload link for someone without an account, see which
 * are alive, revoke the ones that should not be.
 */
export function GuestLinksButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Inbox aria-hidden />
        Receive files
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Guest upload links"
        description="Whoever holds one can send files to you — nothing else — until it expires or you revoke it. What they send shows up in your list."
      >
        <GuestLinksPanel />
      </Dialog>
    </>
  );
}

/** Mounts with the dialog, so its state and clock start fresh on every open. */
function GuestLinksPanel() {
  const [links, setLinks] = useState<GuestLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [ttl, setTtl] = useState(24);
  const [fresh, setFresh] = useState<string | null>(null);
  const now = useNow();

  useEffect(() => {
    let cancelled = false;
    fetchGuestLinks().then((list) => {
      if (cancelled) return;
      if (list) setLinks(list);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function create(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    const result = await createGuestLink({ ttlHours: ttl, label: label.trim() });
    setCreating(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setLabel("");
    setLinks((prev) => [result.link, ...prev]);
    setFresh(result.link.token);
    // Handed over right away: creating a link and then hunting for its copy
    // button is the whole flow, so the copy happens here.
    try {
      await navigator.clipboard.writeText(absoluteUrl(`/guest/${result.link.token}`));
      toast.success("Guest link created and copied");
    } catch {
      toast.success("Guest link created");
    }
  }

  async function revoke(link: GuestLink) {
    if (await revokeGuestLink(link.token)) {
      setLinks((prev) => prev.filter((l) => l.token !== link.token));
      toast.success("Guest link revoked", link.label || undefined);
    } else {
      toast.error("Could not revoke the link");
    }
  }

  return (
    <>
      <form onSubmit={create} className="gl-form">
        <div>
          <label className="label" htmlFor="guest-label">
            For whom <span className="faint">(optional)</span>
          </label>
          <input
            id="guest-label"
            className="input"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="e.g. Marta"
            maxLength={40}
            autoComplete="off"
          />
        </div>
        <Segmented id="guest-ttl" label="Link lifetime" icon={<Hourglass aria-hidden />} options={TTL_OPTIONS} value={ttl} onChange={setTtl} />
        <Button type="submit" variant="primary" block disabled={creating}>
          {creating ? <Loader className="spin" /> : <UserPlus />}
          Create link
        </Button>
      </form>

      <div className="gl-list">
        <p className="card-title">Active links</p>
        {loading ? (
          <Skeleton style={{ height: 56 }} />
        ) : links.length === 0 ? (
          <p className="gl-empty">No active guest links.</p>
        ) : (
          <ul className="gl-items">
            {links.map((link) => (
              <li key={link.token} className="gl-item" data-fresh={fresh === link.token || undefined}>
                <div className="gl-item-row">
                  <div className="gl-item-main">
                    <p className="gl-item-name truncate">{link.label || "Unnamed link"}</p>
                    <p className="gl-item-sub num">
                      expires in {formatRemaining(link.expiresAt, now)}
                      {link.uploadCount > 0 && ` · ${plural(link.uploadCount, "upload")}`}
                    </p>
                  </div>
                  <CopyLinkButton path={`/guest/${link.token}`} size="icon-sm" />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="btn-danger-hover"
                    aria-label={`Revoke ${link.label || "link"}`}
                    title="Revoke"
                    onClick={() => revoke(link)}
                  >
                    <Trash2 />
                  </Button>
                </div>
                {fresh === link.token && <LinkBox path={`/guest/${link.token}`} />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
