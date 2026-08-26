"use client";

import { HardDrive } from "lucide-react";
import { KaiCorpHeader } from "@/components/kaicorp-header";
import { ThemeToggle } from "@/components/theme-toggle";
import { Progress } from "@/components/ui/progress";
import { formatBytes } from "@/lib/format";

interface Props {
  storage?: { usedBytes: number; totalBytes: number } | null;
  actions?: React.ReactNode;
}

/**
 * La cabecera de DocDrop: la común de KaiCorp Labs con lo propio de esta app
 * colgando a la derecha.
 *
 * Se conserva este envoltorio en vez de usar `KaiCorpHeader` directamente en
 * cada página porque las cuatro pantallas que la pintan pasan cosas distintas
 * (el panel manda el medidor de disco, la de invitado no manda nada) y no tiene
 * sentido repetir cuatro veces el mismo montaje.
 */
export function SiteHeader({ storage, actions }: Props) {
  const pct = storage ? Math.min(100, (storage.usedBytes / storage.totalBytes) * 100) : 0;

  return (
    <>
      <KaiCorpHeader app="DocDrop">
        {/* El medidor solo cabe con holgura de sm en adelante. */}
        {storage && (
          <div className="hidden items-center gap-2 sm:flex">
            <HardDrive className="size-3.5 text-muted-foreground" aria-hidden />
            <div className="w-24">
              <Progress value={pct} className="h-1.5" />
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatBytes(storage.usedBytes)} / {formatBytes(storage.totalBytes)}
            </span>
          </div>
        )}
        {actions}
        <ThemeToggle />
      </KaiCorpHeader>

      {/* En móvil el disco baja a una línea fina bajo la cabecera. */}
      {storage && (
        <div
          className="flex items-center gap-2 border-b px-4 pb-2 pt-2 sm:hidden"
          style={{ borderColor: "var(--kc-line)" }}
        >
          <Progress value={pct} className="h-1" />
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {formatBytes(storage.usedBytes)} / {formatBytes(storage.totalBytes)}
          </span>
        </div>
      )}
    </>
  );
}
