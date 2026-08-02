"use client";

import { useState, useCallback, useRef, useEffect } from "react";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatExpiry(timestamp: number): string {
  const diff = timestamp - Date.now();
  if (diff <= 0) return "Expired";
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / (1000 * 60));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface UploadResult {
  id: string;
  originalName: string;
  size: number;
  expiresAt: number;
  downloadUrl: string;
}

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

export default function Home() {
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [ttl, setTtl] = useState(24);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchFiles = useCallback(async () => {
    try {
      const res = await fetch("/api/files");
      if (res.ok) {
        const data = await res.json();
        setFiles(data.files);
      }
    } catch {}
    setLoadingFiles(false);
  }, []);

  useEffect(() => {
    fetchFiles();
    const interval = setInterval(fetchFiles, 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, [fetchFiles]);

  const uploadFile = useCallback(async (file: File) => {
    setUploading(true);
    setProgress(0);
    setError(null);
    setResult(null);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("ttlHours", String(ttl));
    formData.append("maxDownloads", "0");

    try {
      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          setProgress(Math.round((e.loaded / e.total) * 100));
        }
      });

      const response = await new Promise<UploadResult>((resolve, reject) => {
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(JSON.parse(xhr.responseText));
          } else {
            reject(new Error(JSON.parse(xhr.responseText).error || "Upload failed"));
          }
        };
        xhr.onerror = () => reject(new Error("Network error"));
        xhr.open("POST", "/api/upload");
        xhr.send(formData);
      });

      setResult(response);
      fetchFiles(); // Refresh file list
    } catch (err: any) {
      setError(err.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  }, [ttl, fetchFiles]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) uploadFile(file);
    },
    [uploadFile]
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) uploadFile(file);
    },
    [uploadFile]
  );

  const copyLink = async (url: string) => {
    const fullUrl = `${window.location.origin}${url}`;
    await navigator.clipboard.writeText(fullUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const reset = () => {
    setResult(null);
    setError(null);
    setProgress(0);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="flex-1 flex flex-col items-center px-4 py-8 sm:py-12 max-w-2xl mx-auto w-full">
      {/* Logo / Brand */}
      <div className="text-center mb-8">
        <h1 className="text-4xl sm:text-5xl font-bold mb-2">
          <span className="text-accent">Doc</span>Drop
        </h1>
        <p className="text-muted text-sm sm:text-base">
          Upload a file, share the link. It self-destructs. 🔥
        </p>
      </div>

      {/* Upload Area */}
      {!result && (
        <div className="w-full mb-8">
          <div
            className={`relative border-2 border-dashed rounded-2xl p-8 sm:p-10 text-center transition-all duration-200 cursor-pointer ${
              isDragging
                ? "border-accent bg-accent/10 scale-[1.02]"
                : "border-border hover:border-accent/50 hover:bg-surface-light/50"
            } ${uploading ? "pointer-events-none" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => !uploading && fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={handleFileSelect}
            />

            {uploading ? (
              <div className="space-y-4">
                <div className="text-4xl">📡</div>
                <p className="text-foreground font-medium">Uploading...</p>
                <div className="w-full bg-surface-light rounded-full h-2.5 overflow-hidden">
                  <div
                    className="bg-accent h-full rounded-full transition-all duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <p className="text-muted text-sm">{progress}%</p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="text-5xl">📄</div>
                <p className="text-foreground font-medium text-lg">
                  Drop a file here or click to browse
                </p>
                <p className="text-muted text-sm">
                  Any file up to 10GB
                </p>
              </div>
            )}
          </div>

          {/* TTL Selector */}
          <div className="mt-4 flex items-center justify-center gap-3 text-sm">
            <span className="text-muted">Self-destruct after:</span>
            <div className="flex gap-1.5">
              {[1, 6, 24, 72].map((h) => (
                <button
                  key={h}
                  onClick={() => setTtl(h)}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                    ttl === h
                      ? "bg-accent text-white"
                      : "bg-surface-light text-muted hover:text-foreground"
                  }`}
                >
                  {h < 24 ? `${h}h` : `${h / 24}d`}
                </button>
              ))}
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="mt-4 p-3 bg-danger/10 border border-danger/20 rounded-xl text-danger text-sm text-center">
              {error}
            </div>
          )}
        </div>
      )}

      {/* Result Card */}
      {result && (
        <div className="w-full space-y-4 mb-8">
          <div className="bg-surface border border-border rounded-2xl p-6 text-center space-y-4">
            <div className="text-4xl">✅</div>
            <div>
              <p className="text-foreground font-semibold text-lg break-all">
                {result.originalName}
              </p>
              <p className="text-muted text-sm mt-1">
                {formatBytes(result.size)} · expires in {formatExpiry(result.expiresAt)}
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={() => copyLink(result.downloadUrl)}
                className="flex-1 bg-accent hover:bg-accent-hover text-white font-medium py-3 px-5 rounded-xl transition-all active:scale-95"
              >
                {copied ? "✓ Copied!" : "📋 Copy Link"}
              </button>
              <a
                href={result.downloadUrl}
                className="flex-1 bg-surface-light hover:bg-border text-foreground font-medium py-3 px-5 rounded-xl transition-all text-center"
              >
                ⬇️ Download
              </a>
            </div>

            <div className="bg-surface-light rounded-xl p-3 font-mono text-sm text-accent break-all select-all">
              {typeof window !== "undefined"
                ? `${window.location.origin}${result.downloadUrl}`
                : result.downloadUrl}
            </div>
          </div>

          <button
            onClick={reset}
            className="w-full bg-surface hover:bg-surface-light text-muted hover:text-foreground font-medium py-3 px-5 rounded-xl transition-all border border-border"
          >
            ↩ Upload Another File
          </button>
        </div>
      )}

      {/* File Gallery */}
      <div className="w-full">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-foreground">
            📁 Shared Files
          </h2>
          <button
            onClick={fetchFiles}
            className="text-muted hover:text-foreground transition-colors text-sm"
          >
            ↻ Refresh
          </button>
        </div>

        {loadingFiles ? (
          <div className="text-center text-muted py-8">
            <div className="text-2xl mb-2">⏳</div>
            Loading files...
          </div>
        ) : files.length === 0 ? (
          <div className="text-center text-muted py-8 bg-surface rounded-2xl border border-border">
            <div className="text-3xl mb-2">📭</div>
            <p>No shared files yet</p>
            <p className="text-sm mt-1">Upload a file to see it here</p>
          </div>
        ) : (
          <div className="space-y-2">
            {files.map((file) => (
              <a
                key={file.id}
                href={`/d/${file.id}`}
                className="flex items-center gap-4 p-4 bg-surface hover:bg-surface-light border border-border hover:border-accent/30 rounded-xl transition-all group"
              >
                <div className="text-2xl flex-shrink-0">
                  {file.mimeType.startsWith("image/") ? "🖼️" :
                   file.mimeType.startsWith("video/") ? "🎬" :
                   file.mimeType.startsWith("audio/") ? "🎵" :
                   file.mimeType.includes("pdf") ? "📕" :
                   file.mimeType.includes("zip") || file.mimeType.includes("rar") ? "📦" :
                   file.mimeType.includes("text") ? "📝" : "📄"}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-foreground font-medium truncate group-hover:text-accent transition-colors">
                    {file.originalName}
                  </p>
                  <p className="text-muted text-sm mt-0.5">
                    {formatBytes(file.size)} · {timeAgo(file.uploadedAt)} · {file.downloadCount} download{file.downloadCount !== 1 ? "s" : ""}
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <span className="inline-block px-2.5 py-1 text-xs font-medium rounded-full bg-success/10 text-success">
                    {formatExpiry(file.expiresAt)}
                  </span>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}