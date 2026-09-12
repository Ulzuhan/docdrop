import {
  Archive,
  File,
  FileCode,
  FileSpreadsheet,
  FileText,
  Film,
  Image,
  Lock,
  Music,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import { cx } from "@/lib/cx";
import type { FileKind } from "@/lib/file-kind";

const ICONS: Record<FileKind, LucideIcon> = {
  image: Image,
  video: Film,
  audio: Music,
  pdf: FileText,
  archive: Archive,
  document: FileText,
  sheet: FileSpreadsheet,
  slides: Presentation,
  code: FileCode,
  encrypted: Lock,
  file: File,
};

/** A coloured tile with an icon for the file's family. */
export function FileIcon({ kind, size = "md", className }: { kind: FileKind; size?: "sm" | "md" | "lg"; className?: string }) {
  const Icon = ICONS[kind];
  return (
    <span className={cx("fi", size === "sm" && "fi-sm", size === "lg" && "fi-lg", className)} data-kind={kind} aria-hidden>
      <Icon />
    </span>
  );
}
