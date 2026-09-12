import type { ReactNode } from "react";
import { HardDrive } from "lucide-react";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import type { StorageInfo } from "@/lib/api";
import { formatBytes } from "@/lib/format";

function Gauge({ storage }: { storage: StorageInfo }) {
  const fraction = storage.totalBytes > 0 ? storage.usedBytes / storage.totalBytes : 0;
  const pct = Math.min(100, fraction * 100);
  const text = `${formatBytes(storage.usedBytes)} of ${formatBytes(storage.totalBytes)} used`;
  return (
    <div className="gauge" data-level={fraction > 0.9 ? "high" : undefined} title={text}>
      <HardDrive size={14} aria-hidden />
      <div className="gauge-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Storage used">
        <span style={{ width: `${pct}%` }} />
      </div>
      <span className="num">
        {formatBytes(storage.usedBytes)} / {formatBytes(storage.totalBytes)}
      </span>
    </div>
  );
}

/**
 * The header: brand on the left; storage gauge, the screen's own actions and
 * the theme toggle on the right. On a phone the gauge moves to a line under it.
 */
export function Header({ storage, children }: { storage?: StorageInfo | null; children?: ReactNode }) {
  return (
    <>
      <header className="hdr">
        <div className="container hdr-inner">
          <Brand />
          <div className="hdr-actions">
            {storage && <Gauge storage={storage} />}
            {children}
            <ThemeToggle />
          </div>
        </div>
      </header>
      {storage && (
        <div className="container gauge-mobile">
          <Gauge storage={storage} />
        </div>
      )}
    </>
  );
}
