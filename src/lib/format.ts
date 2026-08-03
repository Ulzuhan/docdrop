/** Formatting helpers shared by the dashboard and the viewer (they used to be duplicated in both). */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Time left, short form: "2d 4h", "35m". */
export function formatRemaining(expiresAt: number, now: number): string {
  const diff = expiresAt - now;
  if (diff <= 0) return "expired";

  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/** Time elapsed: "5m ago". */
export function formatAgo(timestamp: number, now: number): string {
  const minutes = Math.floor((now - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

/** Fraction of life already used (0..1), for the expiry bar. */
export function lifeElapsed(uploadedAt: number, expiresAt: number, now: number): number {
  const total = expiresAt - uploadedAt;
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, (now - uploadedAt) / total));
}

/** Rough emoji for the file type. */
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
