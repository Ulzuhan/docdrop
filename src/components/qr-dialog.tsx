"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * Shows the link as a QR code.
 *
 * The fastest way to get a file from the computer to the phone of whoever is next to
 * you: open the code, point the camera, done. No dictating URLs and no detour
 * through a messaging app.
 */
export function QrDialog({ path, filename }: { path: string; filename?: string }) {
  const [open, setOpen] = useState(false);
  // A single piece of state, set when the promise resolves, so there is no
  // synchronous setState inside the effect.
  const [qr, setQr] = useState<{ url: string; dataUrl: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const full = `${window.location.origin}${path}`;

    QRCode.toDataURL(full, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 512,
      // High contrast and always light: readers struggle with inverted codes.
      color: { dark: "#0b0b12", light: "#ffffff" },
    })
      .then((dataUrl) => {
        if (!cancelled) setQr({ url: full, dataUrl });
      })
      .catch(() => {
        if (!cancelled) setQr(null);
      });

    return () => {
      cancelled = true;
    };
  }, [open, path]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="ghost" size="icon" className="size-9" aria-label="Show QR code" />
        }
      >
        <QrCode className="size-4" aria-hidden />
      </DialogTrigger>

      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Scan to download</DialogTitle>
          <DialogDescription className="truncate">
            {filename ?? "Point your phone camera at it"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-2">
          {qr ? (
            // eslint-disable-next-line @next/next/no-img-element -- data: URI generado en el cliente
            <img
              src={qr.dataUrl}
              alt={`QR code for the download link${filename ? ` of ${filename}` : ""}`}
              className="w-full max-w-[260px] rounded-xl border border-border bg-white p-3"
            />
          ) : (
            <div className="grid h-[260px] w-full max-w-[260px] place-items-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">
Generating…
            </div>
          )}

          <p className="w-full break-all text-center font-mono text-xs text-muted-foreground">
            {qr?.url ?? ""}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
