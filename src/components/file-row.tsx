"use client";

import { useState } from "react";
import { Download, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { CopyLinkButton } from "@/components/copy-link-button";
import { ShareButton } from "@/components/share-button";
import { QrDialog } from "@/components/qr-dialog";
import {
  fileEmoji,
  formatAgo,
  formatBytes,
  formatRemaining,
  lifeElapsed,
} from "@/lib/format";

export interface FileInfo {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  uploadedAt: number;
  expiresAt: number;
  downloadCount: number;
  maxDownloads: number;
  uploadedBy?: string;
}

interface Props {
  file: FileInfo;
  now: number;
  onDeleted: (id: string) => void;
  selected: boolean;
  onToggle: (id: string) => void;
}

export function FileRow({ file, now, onDeleted, selected, onToggle }: Props) {
  const [deleting, setDeleting] = useState(false);
  const elapsed = lifeElapsed(file.uploadedAt, file.expiresAt, now) * 100;
  const remaining = formatRemaining(file.expiresAt, now);
  const expiringSoon = file.expiresAt - now < 60 * 60 * 1000;

  async function remove() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/files/${file.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      onDeleted(file.id);
      toast.success("Fichero eliminado", { description: file.originalName });
    } catch {
      toast.error("No se pudo eliminar");
      setDeleting(false);
    }
  }

  return (
    <li className="group relative overflow-hidden rounded-xl border border-border/70 bg-card/60 transition-colors hover:border-border hover:bg-card">
      <div className="flex items-start gap-3 p-3 sm:items-center sm:p-4">
        {/* Seleccionar para descargar varios juntos en un ZIP. */}
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle(file.id)}
          aria-label={`Seleccionar ${file.originalName}`}
          className="mt-1 size-4 shrink-0 accent-primary sm:mt-0"
        />
        <span aria-hidden className="mt-0.5 text-xl sm:mt-0 sm:text-2xl">
          {fileEmoji(file.mimeType, file.originalName)}
        </span>

        <div className="min-w-0 flex-1">
          {/* break-all evita que un nombre largo sin espacios desborde en móvil. */}
          <p className="truncate text-sm font-medium sm:text-[15px]" title={file.originalName}>
            {file.originalName}
          </p>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="tabular-nums">{formatBytes(file.size)}</span>
            <span aria-hidden>·</span>
            <span>{formatAgo(file.uploadedAt, now)}</span>
            {file.uploadedBy && (
              <>
                <span aria-hidden>·</span>
                <span className="max-w-[10rem] truncate">de {file.uploadedBy}</span>
              </>
            )}
            {file.maxDownloads > 0 && (
              <>
                <span aria-hidden>·</span>
                <span className="tabular-nums">
                  {file.downloadCount}/{file.maxDownloads} descargas
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Badge
            variant={expiringSoon ? "destructive" : "secondary"}
            className="hidden tabular-nums sm:inline-flex"
          >
            {remaining}
          </Badge>
          <ShareButton path={`/d/${file.id}`} title={file.originalName} />
          <QrDialog path={`/d/${file.id}`} filename={file.originalName} />
          <CopyLinkButton path={`/d/${file.id}`} variant="ghost" className="size-9" />
          <Button
            render={<a href={`/api/download/${file.id}`} />}
            variant="ghost"
            size="icon"
            className="size-9"
            aria-label={`Descargar ${file.originalName}`}
          >
            <Download className="size-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={remove}
            disabled={deleting}
            aria-label={`Eliminar ${file.originalName}`}
            className="size-9 text-muted-foreground hover:text-destructive"
          >
            {deleting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Trash2 className="size-4" aria-hidden />
            )}
          </Button>
        </div>
      </div>

      {/* Vida restante: en móvil sustituye a la etiqueta, que no cabe. */}
      <div className="flex items-center gap-2 px-3 pb-3 sm:hidden">
        <Progress value={elapsed} className="h-1" />
        <span
          className={`shrink-0 text-[11px] tabular-nums ${
            expiringSoon ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {remaining}
        </span>
      </div>
      <Progress value={elapsed} className="hidden h-0.5 rounded-none sm:block" />
    </li>
  );
}
