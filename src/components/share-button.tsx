"use client";

import { useSyncExternalStore } from "react";
import { Share2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

const noopSubscribe = () => () => {};

/**
 * Shares the link through the system menu.
 *
 * On a phone this is the difference between "copy it and go find where to paste it"
 * and "tap share, pick a chat app". Only rendered when the browser supports it; on
 * desktop the copy button remains the way to go.
 */
export function ShareButton({
  path,
  title,
  className,
}: {
  path: string;
  title?: string;
  className?: string;
}) {
  const canShare = useSyncExternalStore(
    noopSubscribe,
    () => typeof navigator !== "undefined" && typeof navigator.share === "function",
    () => false
  );

  if (!canShare) return null;

  async function share() {
    const url = `${window.location.origin}${path}`;
    try {
      await navigator.share({ title: title || "DocDrop", text: title, url });
    } catch (error) {
      // Dismissing the dialog throws AbortError: not a failure worth reporting.
      if ((error as Error)?.name !== "AbortError") {
        toast.error("Could not share");
      }
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={share}
      aria-label="Share link"
      className={className ?? "size-9"}
    >
      <Share2 className="size-4" aria-hidden />
    </Button>
  );
}
