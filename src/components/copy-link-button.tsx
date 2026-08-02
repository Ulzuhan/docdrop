"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  path: string;
  label?: string;
  className?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
}

export function CopyLinkButton({ path, label, className, variant = "secondary", size }: Props) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const url = `${window.location.origin}${path}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Enlace copiado");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Sin permiso de portapapeles (contexto no seguro): al menos mostrar la URL.
      toast.error("No se pudo copiar", { description: url });
    }
  }

  return (
    <Button
      type="button"
      variant={variant}
      size={size ?? (label ? "default" : "icon")}
      onClick={copy}
      aria-label={label ? undefined : "Copiar enlace"}
      className={cn(className)}
    >
      {copied ? (
        <Check className="size-4 text-success" aria-hidden />
      ) : (
        <Copy className="size-4" aria-hidden />
      )}
      {label ? <span>{copied ? "¡Copiado!" : label}</span> : null}
    </Button>
  );
}
