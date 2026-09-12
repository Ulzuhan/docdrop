import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FileIcon } from "@/components/file-icon";
import { FileCard } from "@/components/file-card";
import type { FileInfo } from "@/lib/api";
import { plural } from "@/lib/format";

interface Props {
  files: FileInfo[];
  loading: boolean;
  now: number;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onClearSelection: () => void;
  onDeleted: (id: string) => void;
}

export function FileList({ files, loading, now, selected, onToggle, onClearSelection, onDeleted }: Props) {
  const zippable = files.filter((f) => !f.encrypted).length;

  /**
   * Downloads the selected files as one archive. It navigates instead of using
   * fetch, so the browser writes straight to disk rather than buffering in
   * memory, which would be unworkable with several GB.
   */
  function downloadZip() {
    const ids = [...selected].join(",");
    if (!ids) return;
    window.location.href = `/api/zip?ids=${ids}`;
    onClearSelection();
  }

  return (
    <section className="dash-files" aria-label="Active files">
      <div className="section-head">
        <h2>Your files</h2>
        {!loading && <span className="count">{files.length}</span>}
        <span className="spacer" />
        {zippable > 1 && selected.size === 0 && (
          <span className="hint faint">Tick files to download them together as a ZIP</span>
        )}
      </div>

      {loading ? (
        <ul className="files" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <li key={i}>
              <Skeleton style={{ height: 76, borderRadius: 16 }} />
            </li>
          ))}
        </ul>
      ) : files.length === 0 ? (
        <div className="empty">
          <FileIcon kind="file" size="lg" />
          <h3>Nothing here yet</h3>
          <p>Files you upload show up here with the time they have left. When it runs out, they delete themselves.</p>
        </div>
      ) : (
        <ul className="files" data-many={files.length > 1 || undefined}>
          {files.map((file) => (
            <FileCard
              key={file.id}
              file={file}
              now={now}
              selected={selected.has(file.id)}
              onToggle={onToggle}
              onDeleted={onDeleted}
            />
          ))}
        </ul>
      )}

      {selected.size > 0 && (
        <div className="selbar" role="region" aria-label="Selected files">
          <strong>{plural(selected.size, "file")} selected</strong>
          <Button variant="primary" size="sm" onClick={downloadZip}>
            <Download />
            Download as ZIP
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Clear selection" onClick={onClearSelection}>
            <X />
          </Button>
        </div>
      )}
    </section>
  );
}
