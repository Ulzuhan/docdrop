import { useState, useSyncExternalStore } from "react";
import { Check, Copy, QrCode, Share2 } from "lucide-react";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/button";
import { QrDialog } from "@/components/qr-dialog";
import { toast } from "@/lib/toast";

export function absoluteUrl(path: string): string {
  return `${window.location.origin}${path}`;
}

const noopSubscribe = () => () => {};

interface Common {
  path: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
  className?: string;
}

/** Copies the full link; the icon flips to a check for a moment. */
export function CopyLinkButton({ path, label, size, variant, className }: Common & { label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const url = absoluteUrl(path);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Link copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard (insecure context): at least show the URL.
      toast.error("Could not copy", url);
    }
  }

  return (
    <Button
      variant={variant ?? (label ? "primary" : "ghost")}
      size={size ?? (label ? "sm" : "icon")}
      onClick={copy}
      aria-label={label ? undefined : "Copy link"}
      title={label ? undefined : "Copy link"}
      className={className}
    >
      {copied ? <Check /> : <Copy />}
      {label && <span>{copied ? "Copied" : label}</span>}
    </Button>
  );
}

/**
 * The system share sheet. On a phone this is the difference between "copy it
 * and go find where to paste it" and "tap, pick a chat". Only rendered where
 * the browser supports it; on a desktop the copy button remains the way.
 */
export function ShareButton({ path, title, size, variant, className }: Common & { title?: string }) {
  const canShare = useSyncExternalStore(
    noopSubscribe,
    () => typeof navigator !== "undefined" && typeof navigator.share === "function",
    () => false
  );
  if (!canShare) return null;

  async function share() {
    const url = absoluteUrl(path);
    try {
      await navigator.share({ title: title || "DocDrop", text: title, url });
    } catch (error) {
      // Dismissing the sheet throws AbortError: not a failure worth reporting.
      if ((error as Error)?.name !== "AbortError") toast.error("Could not share");
    }
  }

  return (
    <Button variant={variant ?? "ghost"} size={size ?? "icon"} onClick={share} aria-label="Share link" title="Share link" className={className}>
      <Share2 />
    </Button>
  );
}

/** Shows the link as a QR code: the fastest way to hand a file to the phone next to you. */
export function QrButton({ path, filename, size, variant, className }: Common & { filename?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant={variant ?? "ghost"}
        size={size ?? "icon"}
        onClick={() => setOpen(true)}
        aria-label="Show QR code"
        title="Show QR code"
        className={className}
      >
        <QrCode />
      </Button>
      <QrDialog open={open} onClose={() => setOpen(false)} path={path} filename={filename} />
    </>
  );
}

/** Copy, share and QR, side by side. */
export function LinkActions({ path, title, size }: { path: string; title?: string; size?: ButtonSize }) {
  return (
    <>
      <ShareButton path={path} title={title} size={size} />
      <QrButton path={path} filename={title} size={size} />
      <CopyLinkButton path={path} size={size} />
    </>
  );
}
