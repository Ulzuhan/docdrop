import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Dialog } from "@/components/ui/dialog";
import { CopyLinkButton } from "@/components/link-actions";

interface Props {
  open: boolean;
  onClose: () => void;
  path: string;
  filename?: string;
}

export function QrDialog({ open, onClose, path, filename }: Props) {
  const [qr, setQr] = useState<{ url: string; dataUrl: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const full = `${window.location.origin}${path}`;
    QRCode.toDataURL(full, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 640,
      // Always dark on white: readers struggle with inverted codes.
      color: { dark: "#0b0d14", light: "#ffffff" },
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
    <Dialog open={open} onClose={onClose} size="sm" title="Scan to open" description={filename ?? "Point a phone camera at it"}>
      <div className="qr">
        {qr ? (
          <img src={qr.dataUrl} alt={`QR code for the link${filename ? ` to ${filename}` : ""}`} className="qr-img" />
        ) : (
          <div className="qr-img qr-empty">
            <span className="spinner" aria-hidden />
          </div>
        )}
        <p className="qr-url mono break">{qr?.url ?? ""}</p>
        <CopyLinkButton path={path} label="Copy link" variant="secondary" size="md" className="btn-block" />
      </div>
    </Dialog>
  );
}
