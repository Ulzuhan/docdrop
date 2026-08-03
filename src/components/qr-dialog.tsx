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
 * Muestra el enlace como código QR.
 *
 * Es la forma más rápida de pasar un fichero del ordenador al móvil de otra persona
 * que está al lado: se abre el QR, lo escanea con la cámara y ya está descargando.
 * Sin dictar URLs ni pasar por otro canal de mensajería.
 */
export function QrDialog({ path, filename }: { path: string; filename?: string }) {
  const [open, setOpen] = useState(false);
  // Un único estado, asignado cuando la promesa resuelve: así no hay setState
  // síncrono dentro del efecto.
  const [qr, setQr] = useState<{ url: string; dataUrl: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const full = `${window.location.origin}${path}`;

    QRCode.toDataURL(full, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 512,
      // Alto contraste y siempre en claro: los lectores fallan con QR invertidos.
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
          <Button variant="ghost" size="icon" className="size-9" aria-label="Mostrar código QR" />
        }
      >
        <QrCode className="size-4" aria-hidden />
      </DialogTrigger>

      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Escanea para descargar</DialogTitle>
          <DialogDescription className="truncate">
            {filename ?? "Apunta con la cámara del móvil"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-2">
          {qr ? (
            // eslint-disable-next-line @next/next/no-img-element -- data: URI generado en el cliente
            <img
              src={qr.dataUrl}
              alt={`Código QR del enlace de descarga${filename ? ` de ${filename}` : ""}`}
              className="w-full max-w-[260px] rounded-xl border border-border bg-white p-3"
            />
          ) : (
            <div className="grid h-[260px] w-full max-w-[260px] place-items-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">
              Generando…
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
