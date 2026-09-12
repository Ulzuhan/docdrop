import { Link2 } from "lucide-react";
import { CopyLinkButton, absoluteUrl } from "@/components/link-actions";

/**
 * The link, in full, with its copy button: what you take away from an upload.
 * The key after `#` is shown in ice so it is obviously part of the link and
 * not something to trim.
 */
export function LinkBox({ path, label = "Copy link" }: { path: string; label?: string }) {
  const url = absoluteUrl(path);
  const hashAt = url.indexOf("#");
  const main = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const key = hashAt >= 0 ? url.slice(hashAt) : "";
  return (
    <div className="linkbox">
      <Link2 aria-hidden />
      <code title={url}>
        {main}
        {key && <span className="key">{key}</span>}
      </code>
      <CopyLinkButton path={path} label={label} size="sm" />
    </div>
  );
}
