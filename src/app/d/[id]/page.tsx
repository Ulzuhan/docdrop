"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";

interface FileInfo {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  uploadedAt: number;
  expiresAt: number;
  downloadCount: number;
  maxDownloads: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

function formatExpiry(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return "Expired";
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export default function DownloadPage() {
  const params = useParams();
  const id = params.id as string;
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    async function fetchInfo() {
      try {
        const res = await fetch(`/api/info/${id}`);
        if (!res.ok) {
          const data = await res.json();
          setError(data.error || "File not found");
          return;
        }
        setFileInfo(await res.json());
      } catch {
        setError("Failed to load file info");
      } finally {
        setLoading(false);
      }
    }
    fetchInfo();
  }, [id]);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const link = document.createElement("a");
      link.href = `/api/download/${id}`;
      link.download = fileInfo?.originalName || "file";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      setTimeout(() => setDownloading(false), 1500);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[calc(100vh-3.5rem)]">
        <div className="text-center space-y-3">
          <div className="text-4xl animate-pulse">📡</div>
          <p className="text-muted">Loading file info...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[calc(100vh-3.5rem)]">
        <div className="bg-surface border border-border rounded-2xl p-8 text-center max-w-md w-full mx-4 space-y-4">
          <div className="text-5xl">💔</div>
          <h2 className="text-xl font-bold text-foreground">File Not Available</h2>
          <p className="text-muted">{error}</p>
          <p className="text-muted text-sm">This file may have expired or reached its download limit.</p>
          <a
            href="/"
            className="inline-block bg-accent hover:bg-accent-hover text-white font-medium py-2.5 px-6 rounded-xl transition-all"
          >
            Upload a New File
          </a>
        </div>
      </div>
    );
  }

  if (!fileInfo) return null;

  const isExpired = fileInfo.expiresAt < Date.now();

  return (
    <div className="flex-1 flex items-center justify-center min-h-[calc(100vh-3.5rem)]">
      <div className="bg-surface border border-border rounded-2xl p-6 sm:p-8 max-w-md w-full mx-4 space-y-6">
        <div className="text-center space-y-3">
          <div className="text-5xl">📄</div>
          <h2 className="text-xl font-bold text-foreground break-all">
            {fileInfo.originalName}
          </h2>
        </div>

        <div className="bg-surface-light rounded-xl p-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted">Size</span>
            <span className="text-foreground font-medium">{formatBytes(fileInfo.size)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Type</span>
            <span className="text-foreground font-medium font-mono text-xs">{fileInfo.mimeType}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Uploaded</span>
            <span className="text-foreground font-medium">{formatTime(fileInfo.uploadedAt)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Expires</span>
            <span className={`font-medium ${isExpired ? "text-danger" : "text-success"}`}>
              {isExpired ? "Expired" : formatExpiry(fileInfo.expiresAt)}
            </span>
          </div>
          {fileInfo.maxDownloads > 0 && (
            <div className="flex justify-between">
              <span className="text-muted">Downloads</span>
              <span className="text-foreground font-medium">
                {fileInfo.downloadCount}/{fileInfo.maxDownloads}
              </span>
            </div>
          )}
        </div>

        {!isExpired ? (
          <button
            onClick={handleDownload}
            disabled={downloading}
            className="w-full bg-accent hover:bg-accent-hover disabled:opacity-50 text-white font-bold py-4 px-6 rounded-xl transition-all active:scale-95 text-lg"
          >
            {downloading ? "⬇️ Downloading..." : "⬇️ Download File"}
          </button>
        ) : (
          <div className="text-center text-danger font-medium">
            This file has expired and is no longer available.
          </div>
        )}

        <a
          href="/"
          className="block text-center text-muted hover:text-foreground transition-colors text-sm"
        >
          Upload your own file →
        </a>
      </div>
    </div>
  );
}