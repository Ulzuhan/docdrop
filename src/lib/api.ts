/**
 * The HTTP surface the screens talk to, typed once. Every function swallows
 * network failures into a result the caller can render; nothing here throws
 * for an expected server answer.
 */

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
  /** The content is an encrypted bundle: name and type above are placeholders. */
  encrypted?: boolean;
}

/** What `/api/info` adds for whoever holds a link. */
export interface PublicFileInfo extends FileInfo {
  /** The bundle's encrypted header in base64; only the key in the link opens it. */
  header?: string;
}

export interface StorageInfo {
  usedBytes: number;
  totalBytes: number;
}

export interface GuestLink {
  token: string;
  label?: string | null;
  createdAt: number;
  expiresAt: number;
  uploadCount: number;
}

export interface GuestInfo {
  label: string | null;
  expiresAt: number;
}

export type FilesResult =
  | { ok: true; files: FileInfo[]; storage: StorageInfo | null }
  | { ok: false; unauthorized: boolean };

export async function fetchFiles(): Promise<FilesResult> {
  try {
    const res = await fetch("/api/files");
    if (res.status === 401) return { ok: false, unauthorized: true };
    if (!res.ok) return { ok: false, unauthorized: false };
    const data = (await res.json()) as { files: FileInfo[]; storage?: StorageInfo };
    return { ok: true, files: data.files ?? [], storage: data.storage ?? null };
  } catch {
    return { ok: false, unauthorized: false };
  }
}

export async function deleteFile(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/files/${id}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchGuestLinks(): Promise<GuestLink[] | null> {
  try {
    const res = await fetch("/api/guest-links");
    if (!res.ok) return null;
    const data = (await res.json()) as { links: GuestLink[] };
    return data.links ?? [];
  } catch {
    return null;
  }
}

export async function createGuestLink(input: {
  ttlHours: number;
  label?: string;
}): Promise<{ ok: true; link: GuestLink } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/guest-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ttlHours: input.ttlHours, label: input.label || undefined }),
    });
    const data = (await res.json().catch(() => ({}))) as { link?: GuestLink; error?: string };
    if (!res.ok || !data.link) return { ok: false, error: data.error || "Could not create the link" };
    return { ok: true, link: data.link };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

export async function revokeGuestLink(token: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/guest-links/${token}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchGuestInfo(token: string): Promise<GuestInfo | null> {
  try {
    const res = await fetch(`/api/guest/${token}`);
    if (!res.ok) return null;
    return (await res.json()) as GuestInfo;
  } catch {
    return null;
  }
}

export type InfoResult =
  | { ok: true; info: PublicFileInfo }
  | { ok: false; error: string; reason: "expired" | "exhausted" | null };

export async function fetchFileInfo(id: string): Promise<InfoResult> {
  try {
    const res = await fetch(`/api/info/${id}`);
    const data = (await res.json().catch(() => ({}))) as Partial<PublicFileInfo> & {
      error?: string;
      reason?: string;
    };
    if (!res.ok) {
      const reason = data.reason === "expired" || data.reason === "exhausted" ? data.reason : null;
      return { ok: false, error: data.error || "File not found", reason };
    }
    return { ok: true, info: data as PublicFileInfo };
  } catch {
    return { ok: false, error: "Could not load the file information", reason: null };
  }
}

/** Closes the session here and returns where to go to close it at the provider. */
export async function signOut(): Promise<string> {
  try {
    const res = await fetch("/api/auth/logout", { method: "POST" });
    const data = (await res.json().catch(() => ({}))) as { next?: string };
    return typeof data.next === "string" && data.next ? data.next : "/";
  } catch {
    return "/";
  }
}

export const SIGN_IN_URL = "/api/auth/login";
