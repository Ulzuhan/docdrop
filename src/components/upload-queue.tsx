import { Check, CircleCheck, KeyRound, Lock, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { FileIcon } from "@/components/file-icon";
import { LinkBox } from "@/components/link-box";
import { QrButton, ShareButton } from "@/components/link-actions";
import { fileKind } from "@/lib/file-kind";
import { formatBytes, formatEta, formatRate, plural } from "@/lib/format";
import type { QueueItem } from "@/lib/upload-queue";
import { useNow } from "@/lib/use-now";

interface Props {
  items: QueueItem[];
  onCancel: (key: string) => void;
  onRetry: (key: string) => void;
  onRemove: (key: string) => void;
  onClearFinished: () => void;
  /**
   * Whoever uploads through a guest link is NOT the recipient: the file is for
   * whoever sent the link, and with encryption born in this browser the only
   * copy of the key is in the download link just produced. In this mode every
   * finished upload says so plainly and makes copying the main action.
   */
  guestMode?: boolean;
}

export function UploadQueue({ items, onCancel, onRetry, onRemove, onClearFinished, guestMode = false }: Props) {
  const now = useNow(1000);
  if (items.length === 0) return null;

  const active = items.filter((i) => i.state === "uploading" || i.state === "pending");
  const done = items.filter((i) => i.state === "done");
  const totalBytes = items.reduce((sum, i) => sum + i.total, 0);
  const loadedBytes = items.reduce((sum, i) => sum + (i.state === "done" ? i.total : i.loaded), 0);
  const overall = totalBytes > 0 ? (loadedBytes / totalBytes) * 100 : 0;
  const moving = items.some((i) => i.state === "uploading");
  const finished = items.some((i) => i.state !== "uploading" && i.state !== "pending");

  return (
    <section aria-label="Upload queue" className="card queue">
      <div className="queue-head">
        <div className="queue-head-row">
          {active.length > 0 ? (
            <span className="spinner" aria-hidden />
          ) : (
            <CircleCheck size={16} aria-hidden style={{ color: "var(--ok-text)" }} />
          )}
          <strong>
            {active.length > 0
              ? `Uploading ${items.length - active.length + 1} of ${items.length}`
              : done.length === items.length
                ? `${plural(done.length, "file")} uploaded`
                : `${plural(done.length, "file")} uploaded, ${items.length - done.length} not`}
          </strong>
          {moving && <span className="muted">· keep this tab open</span>}
          <span className="num">
            {formatBytes(loadedBytes)} / {formatBytes(totalBytes)}
          </span>
        </div>
        {items.length > 1 && <Progress value={overall} live={moving} size="sm" label="Overall progress" />}
      </div>

      <ul className="queue-list" data-many={items.length > 1 || undefined}>
        {items.map((item) => (
          <QueueRow
            key={item.key}
            item={item}
            now={now}
            guestMode={guestMode}
            onCancel={onCancel}
            onRetry={onRetry}
            onRemove={onRemove}
          />
        ))}
      </ul>

      {finished && (
        <div className="queue-foot">
          <Button variant="ghost" size="sm" onClick={onClearFinished}>
            Clear finished
          </Button>
        </div>
      )}
    </section>
  );
}

function QueueRow({
  item,
  now,
  guestMode,
  onCancel,
  onRetry,
  onRemove,
}: {
  item: QueueItem;
  now: number;
  guestMode: boolean;
  onCancel: (key: string) => void;
  onRetry: (key: string) => void;
  onRemove: (key: string) => void;
}) {
  const name = item.file.name;
  const kind = fileKind(item.file.type, name);
  const pct = item.state === "done" ? 100 : item.total > 0 ? (item.loaded / item.total) * 100 : 0;

  // Average rate of this attempt: stable, no jitter, and right for a resume
  // because the bytes that were already there do not count.
  const elapsed = item.startedAt ? (now - item.startedAt) / 1000 : 0;
  const rate = elapsed > 2 ? (item.loaded - (item.baseline ?? 0)) / elapsed : 0;
  const eta = rate > 0 ? (item.total - item.loaded) / rate : NaN;

  return (
    <li className="qi" data-state={item.state}>
      <div className="qi-row">
        <FileIcon kind={kind} size="sm" />
        <div className="qi-main">
          <p className="qi-name truncate" title={name}>
            {name}
          </p>
          <p className="qi-status">
            {item.state === "pending" && <span>Waiting for its turn</span>}
            {item.state === "uploading" && (
              <>
                <span className="num">
                  {formatBytes(item.loaded)} of {formatBytes(item.total)} · {Math.round(pct)}%
                </span>
                {rate > 0 && <span className="num">{formatRate(rate)}</span>}
                {Number.isFinite(eta) && <span>{formatEta(eta)}</span>}
                {item.resumed && <span className="ok">resumed</span>}
              </>
            )}
            {item.state === "done" && (
              <>
                <span className="num">{formatBytes(item.file.size)}</span>
                {item.result?.encrypted && (
                  <span className="ok">
                    <Lock size={11} aria-hidden style={{ display: "inline", verticalAlign: "-1px", marginRight: 4 }} />
                    encrypted in your browser
                  </span>
                )}
              </>
            )}
            {item.state === "error" && <span className="err">{item.error ?? "Upload failed"}</span>}
            {item.state === "cancelled" && <span>Cancelled</span>}
          </p>
        </div>

        <div className="qi-actions">
          {(item.state === "uploading" || item.state === "pending") && (
            <Button variant="ghost" size="icon-sm" aria-label={`Cancel ${name}`} title="Cancel" onClick={() => onCancel(item.key)}>
              <X />
            </Button>
          )}
          {(item.state === "error" || item.state === "cancelled") && (
            <>
              <Button variant="ghost" size="icon-sm" aria-label={`Retry ${name}`} title="Retry" onClick={() => onRetry(item.key)}>
                <RotateCcw />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={`Remove ${name} from the list`} title="Remove" onClick={() => onRemove(item.key)}>
                <X />
              </Button>
            </>
          )}
          {item.state === "done" && item.result && !guestMode && (
            <>
              <ShareButton path={item.result.downloadUrl} title={item.result.originalName} size="icon-sm" />
              <QrButton path={item.result.downloadUrl} filename={item.result.originalName} size="icon-sm" />
            </>
          )}
          {item.state === "done" && (
            <span className="qi-done-icon" aria-label="Uploaded" role="img">
              <Check />
            </span>
          )}
        </div>
      </div>

      {(item.state === "uploading" || item.state === "pending") && (
        <Progress value={pct} live={item.state === "uploading"} size="sm" label={`Progress of ${name}`} />
      )}

      {item.state === "done" && item.result && !guestMode && <LinkBox path={item.result.downloadUrl} />}

      {guestMode && item.state === "done" && item.result && !item.result.encrypted && (
        <div className="note" data-tone="ok">
          <p className="note-title">
            <CircleCheck aria-hidden />
            Delivered
          </p>
          <p>Whoever gave you this link already sees it in their DocDrop and can download it from there. Nothing else to send.</p>
        </div>
      )}

      {guestMode && item.state === "done" && item.result && item.result.encrypted && (
        /* The screen that must be impossible to ignore: this link IS the file.
           The server keeps a bundle it cannot open, and the only key is here,
           in this browser, inside this link. */
        <div className="note" data-tone="ice">
          <p className="note-title">
            <KeyRound aria-hidden />
            Send this link back — it is the only key
          </p>
          <p>
            The file was encrypted in your browser before it left. Whoever asked for it cannot open it without this
            link, and neither can the server. Copy it and send it to them.
          </p>
          <LinkBox path={item.result.downloadUrl} />
        </div>
      )}
    </li>
  );
}
