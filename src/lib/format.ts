/** Formatting shared by every screen. */

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
  return `${Math.max(1, minutes)}m`;
}

/** Time left in one unit, for a tight space: "2d", "4h", "35m". */
export function formatRemainingCompact(expiresAt: number, now: number): string {
  const diff = expiresAt - now;
  if (diff <= 0) return "0m";
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  return `${Math.max(1, minutes)}m`;
}

/** Time left, spoken: "2 days", "4 hours", "35 minutes". */
export function formatRemainingLong(expiresAt: number, now: number): string {
  const diff = expiresAt - now;
  if (diff <= 0) return "expired";
  const minutes = Math.max(1, Math.round(diff / 60_000));
  const hours = Math.round(diff / 3_600_000);
  const days = Math.round(diff / 86_400_000);
  if (days >= 2) return `${days} days`;
  if (hours >= 2) return `${hours} hours`;
  if (minutes >= 60) return "1 hour";
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
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
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(timestamp)
  );
}

/** Fraction of life already used (0..1). */
export function lifeElapsed(uploadedAt: number, expiresAt: number, now: number): number {
  const total = expiresAt - uploadedAt;
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, (now - uploadedAt) / total));
}

/** Transfer speed: "12 MB/s". */
export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "";
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Time to go: "about 2 min left", "a few seconds left". */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 8) return "a few seconds left";
  if (seconds < 60) return `${Math.round(seconds)} s left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  return `about ${hours} h ${minutes % 60} min left`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function hoursLabel(hours: number): string {
  if (hours < 24) return `${hours} h`;
  const days = hours / 24;
  return days === 1 ? "1 day" : `${days} days`;
}
