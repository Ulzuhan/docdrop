"use client";

import Link from "next/link";
import { HardDrive } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Progress } from "@/components/ui/progress";
import { formatBytes } from "@/lib/format";

interface Props {
  storage?: { usedBytes: number; totalBytes: number } | null;
  actions?: React.ReactNode;
}

export function SiteHeader({ storage, actions }: Props) {
  const pct = storage ? Math.min(100, (storage.usedBytes / storage.totalBytes) * 100) : 0;

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 w-full max-w-3xl items-center gap-3 px-4 sm:h-16 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span
            aria-hidden
            className="grid size-8 place-items-center rounded-lg bg-primary/12 text-base ring-1 ring-primary/25"
          >
            📄
          </span>
          <span className="text-[15px] sm:text-base">
            <span className="text-primary">Doc</span>Drop
          </span>
        </Link>

        {/* The storage indicator only fits comfortably from sm upwards. */}
        {storage && (
          <div className="ml-auto hidden items-center gap-2 sm:flex">
            <HardDrive className="size-3.5 text-muted-foreground" aria-hidden />
            <div className="w-24">
              <Progress value={pct} className="h-1.5" />
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatBytes(storage.usedBytes)} / {formatBytes(storage.totalBytes)}
            </span>
          </div>
        )}

        <div className={`flex items-center gap-1 ${storage ? "sm:ml-0" : ""} ml-auto`}>
          {actions}
          <ThemeToggle />
        </div>
      </div>

      {/* On mobile, disk usage moves to a thin line under the header. */}
      {storage && (
        <div className="flex items-center gap-2 px-4 pb-2 sm:hidden">
          <Progress value={pct} className="h-1" />
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {formatBytes(storage.usedBytes)} / {formatBytes(storage.totalBytes)}
          </span>
        </div>
      )}
    </header>
  );
}
