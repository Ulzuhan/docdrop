import { useState } from "react";
import { Download, Loader, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Ring } from "@/components/ui/ring";
import { FileIcon } from "@/components/file-icon";
import { LinkActions } from "@/components/link-actions";
import { deleteFile, type FileInfo } from "@/lib/api";
import { entradaLlavero } from "@/lib/e2ee-client";
import { fileKind } from "@/lib/file-kind";
import { formatAgo, formatBytes, formatRemaining, formatRemainingCompact, lifeElapsed } from "@/lib/format";
import { toast } from "@/lib/toast";

interface Props {
  file: FileInfo;
  now: number;
  selected: boolean;
  onToggle: (id: string) => void;
  onDeleted: (id: string) => void;
}

export function FileCard({ file, now, selected, onToggle, onDeleted }: Props) {
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  /**
   * An encrypted file comes from the server with a placeholder name: the real
   * one only exists in the keyring of the browser it was uploaded from. That
   * keyring also decides which link is copied: without the key fragment, a link
   * copied from another device opens nothing, and it is better to say so.
   */
  const keyring = file.encrypted ? entradaLlavero(file.id) : null;
  const name = file.encrypted ? (keyring?.name ?? "Encrypted file") : file.originalName;
  const path = `/d/${file.id}${keyring ? `#${keyring.k}` : ""}`;
  const missingKey = Boolean(file.encrypted && !keyring);
  const kind = file.encrypted ? "encrypted" : fileKind(file.mimeType, file.originalName);

  const remaining = formatRemaining(file.expiresAt, now);
  const left = 1 - lifeElapsed(file.uploadedAt, file.expiresAt, now);
  const soon = file.expiresAt - now < 3_600_000;

  async function remove() {
    setDeleting(true);
    if (await deleteFile(file.id)) {
      setConfirm(false);
      onDeleted(file.id);
      toast.success("File deleted", name);
    } else {
      toast.error("Could not delete it");
      setDeleting(false);
    }
  }

  return (
    <li className="fc" data-file-id={file.id} data-selected={selected || undefined}>
      <div className="fc-check">
        {/* The ZIP is built by the server, which can only pack unreadable
            ciphertext out of an encrypted bundle: those stay out of the selection. */}
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle(file.id)}
          aria-label={`Select ${name}`}
          disabled={Boolean(file.encrypted)}
          title={file.encrypted ? "Encrypted files cannot be zipped by the server" : "Select to download several as a ZIP"}
        />
      </div>

      <FileIcon kind={kind} className="fc-icon" />

      <div className="fc-main">
        <a className="fc-name" href={path} title={name} target="_blank" rel="noopener">
          {name}
        </a>
        <div className="fc-meta">
          <span className="num">{formatBytes(file.size)}</span>
          <span>{formatAgo(file.uploadedAt, now)}</span>
          {file.uploadedBy && (
            <span className="truncate" style={{ maxWidth: "11rem" }}>
              by {file.uploadedBy}
            </span>
          )}
          {file.maxDownloads > 0 && (
            <span className="num">
              {file.downloadCount}/{file.maxDownloads} downloads
            </span>
          )}
          {file.encrypted &&
            (missingKey ? (
              <span className="warn">key lives in the browser it was uploaded from</span>
            ) : (
              <span>encrypted</span>
            ))}
        </div>
      </div>

      <div className="fc-actions">
        {/* Without the key there is nothing to share: a link missing its secret
            half opens a "key is missing" screen. */}
        {!missingKey && <LinkActions path={path} title={name} />}
        <a
          className="btn btn-ghost btn-icon"
          href={file.encrypted ? path : `/api/download/${file.id}`}
          target={file.encrypted ? "_blank" : undefined}
          rel={file.encrypted ? "noopener" : undefined}
          aria-label={`Download ${name}`}
          title="Download"
        >
          <Download />
        </a>
        <Button
          variant="ghost"
          size="icon"
          className="btn-danger-hover"
          aria-label={`Delete ${name}`}
          title="Delete"
          onClick={() => setConfirm(true)}
        >
          <Trash2 />
        </Button>
      </div>

      <div className="fc-ring">
        <Ring
          fraction={left}
          label={formatRemainingCompact(file.expiresAt, now)}
          tone={soon ? "danger" : undefined}
          title={`Expires in ${remaining}`}
        />
      </div>

      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        size="sm"
        title="Delete this file?"
        description={`“${name}” will be gone for good. Anyone holding its link will find it unavailable.`}
      >
        <div className="dialog-actions">
          <Button variant="ghost" onClick={() => setConfirm(false)}>
            Keep it
          </Button>
          <Button variant="danger" data-action="confirm-delete" onClick={remove} disabled={deleting}>
            {deleting ? <Loader className="spin" /> : <Trash2 />}
            Delete
          </Button>
        </div>
      </Dialog>
    </li>
  );
}
