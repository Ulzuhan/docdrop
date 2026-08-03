"use client";

import { useSyncExternalStore } from "react";
import { Share2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

const noopSubscribe = () => () => {};

/**
 * Comparte el enlace con el menú del sistema.
 *
 * En el móvil esto es la diferencia entre "copia y busca dónde pegarlo" y "toca
 * compartir, elige WhatsApp". Solo se muestra si el navegador lo soporta; en
 * escritorio se sigue usando el botón de copiar.
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
      // Cancelar el diálogo lanza AbortError: no es un fallo que reportar.
      if ((error as Error)?.name !== "AbortError") {
        toast.error("No se pudo compartir");
      }
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={share}
      aria-label="Compartir enlace"
      className={className ?? "size-9"}
    >
      <Share2 className="size-4" aria-hidden />
    </Button>
  );
}
