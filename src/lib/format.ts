/** Formateadores compartidos por el panel y el visor (antes duplicados en ambos). */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Tiempo restante en formato corto: "2d 4h", "35m". */
export function formatRemaining(expiresAt: number, now: number): string {
  const diff = expiresAt - now;
  if (diff <= 0) return "caducado";

  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/** Tiempo transcurrido: "hace 5m". */
export function formatAgo(timestamp: number, now: number): string {
  const minutes = Math.floor((now - timestamp) / 60_000);
  if (minutes < 1) return "ahora mismo";
  if (minutes < 60) return `hace ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours}h`;
  return `hace ${Math.floor(hours / 24)}d`;
}

export function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat("es-ES", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

/** Fracción de vida ya consumida (0..1), para la barra de caducidad. */
export function lifeElapsed(uploadedAt: number, expiresAt: number, now: number): number {
  const total = expiresAt - uploadedAt;
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, (now - uploadedAt) / total));
}

/** Emoji orientativo según el tipo de fichero. */
export function fileEmoji(mimeType: string, name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (mimeType.startsWith("image/")) return "🖼️";
  if (mimeType.startsWith("video/")) return "🎬";
  if (mimeType.startsWith("audio/")) return "🎵";
  if (mimeType === "application/pdf" || ext === "pdf") return "📕";
  if (["zip", "gz", "tar", "rar", "7z", "xz", "zst"].includes(ext)) return "🗜️";
  if (["doc", "docx", "odt", "rtf"].includes(ext)) return "📝";
  if (["xls", "xlsx", "ods", "csv"].includes(ext)) return "📊";
  if (["ppt", "pptx", "odp"].includes(ext)) return "📽️";
  if (["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "sh", "json", "yml", "yaml"].includes(ext))
    return "🧩";
  return "📄";
}
