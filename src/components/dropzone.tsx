import type { MouseEvent } from "react";
import { ArrowDownToLine, CloudUpload, FilePlus2, FolderUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePickers } from "@/lib/dropzone";
import { cx } from "@/lib/cx";

interface Props {
  onFiles: (files: File[]) => void;
  /** A file drag is over the window: the zone lights up and says what to do. */
  dragging: boolean;
  folders?: boolean;
  compact?: boolean;
}

/**
 * The drop zone. The whole panel opens the picker on click, the two buttons
 * are the explicit way in, and the window around it accepts drops too.
 */
export function Dropzone({ onFiles, dragging, folders = true, compact = false }: Props) {
  const { fileInput, folderInput, openFiles, openFolder, onChange } = usePickers(onFiles);

  function onPanelClick(event: MouseEvent<HTMLDivElement>) {
    // A programmatic click on the hidden input bubbles up here: ignore it.
    if ((event.target as HTMLElement).tagName === "INPUT") return;
    openFiles();
  }

  return (
    <div className={cx("dz", compact && "dz-compact")} data-active={dragging || undefined} onClick={onPanelClick}>
      <input
        ref={fileInput}
        type="file"
        multiple
        className="visually-hidden"
        tabIndex={-1}
        aria-hidden
        onChange={onChange}
      />
      {folders && (
        <input
          ref={folderInput}
          type="file"
          multiple
          className="visually-hidden"
          tabIndex={-1}
          aria-hidden
          onChange={onChange}
          {...({ webkitdirectory: "" } as Record<string, string>)}
        />
      )}

      <div className="dz-body">
        <div className="dz-orb" aria-hidden>
          {dragging ? <ArrowDownToLine /> : <CloudUpload />}
        </div>
        <p className="dz-title">{dragging ? "Release to upload" : "Drop files here"}</p>
        <p className="dz-sub">{folders ? "Several at once, whole folders too" : "Several at once"} · up to 10 GB each</p>
        <div className="dz-actions">
          <Button
            variant="primary"
            onClick={(event) => {
              event.stopPropagation();
              openFiles();
            }}
          >
            <FilePlus2 />
            Choose files
          </Button>
          {folders && (
            <Button
              variant="outline"
              onClick={(event) => {
                event.stopPropagation();
                openFolder();
              }}
            >
              <FolderUp />
              Choose a folder
            </Button>
          )}
        </div>
        <p className="dz-fine">
          Paste works too. If the connection drops, pick the same file again and it resumes.
        </p>
      </div>
    </div>
  );
}

/** Full-window overlay while a file is dragged across the page. */
export function DropOverlay({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div className="drop-overlay" aria-hidden>
      <div className="drop-overlay-frame">
        <ArrowDownToLine />
        <span>
          Drop anywhere to upload
          <small>Encrypted in your browser before it leaves</small>
        </span>
      </div>
    </div>
  );
}
