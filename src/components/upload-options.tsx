import { Download, Flame, Lock, LockOpen, SlidersHorizontal } from "lucide-react";
import { Segmented } from "@/components/ui/segmented";
import { hoursLabel } from "@/lib/format";

export const TTL_OPTIONS = [1, 6, 24, 72].map((hours) => ({ value: hours, label: hoursLabel(hours) }));

/** 0 = no limit. With a limit, the file is deleted once it runs out. */
export const DOWNLOAD_OPTIONS = [
  { value: 0, label: "∞", ariaLabel: "No limit" },
  { value: 1, label: "1", ariaLabel: "1 download" },
  { value: 5, label: "5", ariaLabel: "5 downloads" },
  { value: 20, label: "20", ariaLabel: "20 downloads" },
];

/**
 * Whether the next uploads are encrypted in the browser. On by default and
 * asked every time: the safe setting should not depend on what somebody picked
 * another day. Off is a real choice with a real price, and the control says it.
 */
export function EncryptionChoice({ value, onChange }: { value: boolean; onChange: (encrypt: boolean) => void }) {
  return (
    <div>
      <span id="encrypt-label" className="field-label">
        <Lock aria-hidden />
        Encryption
      </span>
      <div role="radiogroup" aria-labelledby="encrypt-label" className="choice">
        <button
          type="button"
          role="radio"
          aria-checked={value}
          data-tone="ice"
          className="choice-opt"
          onClick={() => onChange(true)}
        >
          <Lock aria-hidden />
          In your browser
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={!value}
          className="choice-opt"
          onClick={() => onChange(false)}
        >
          <LockOpen aria-hidden />
          Off
        </button>
      </div>
      <p className="choice-note">
        {value
          ? "The key travels in the link; this server cannot open the file. Lose the link, lose the file."
          : "The server can read the file. In return it can preview it, zip it, and the link has no key to lose."}
      </p>
    </div>
  );
}

interface Props {
  ttl: number;
  setTtl: (hours: number) => void;
  maxDownloads: number;
  setMaxDownloads: (n: number) => void;
  encrypt: boolean;
  setEncrypt: (on: boolean) => void;
}

export function UploadOptions({ ttl, setTtl, maxDownloads, setMaxDownloads, encrypt, setEncrypt }: Props) {
  return (
    <section className="card opts" aria-label="Settings for new uploads">
      <p className="card-title">
        <SlidersHorizontal aria-hidden />
        New uploads
      </p>
      <Segmented id="ttl" label="Expires in" icon={<Flame aria-hidden />} options={TTL_OPTIONS} value={ttl} onChange={setTtl} />
      <Segmented
        id="downloads"
        label="Download limit"
        icon={<Download aria-hidden />}
        options={DOWNLOAD_OPTIONS}
        value={maxDownloads}
        onChange={setMaxDownloads}
      />
      <EncryptionChoice value={encrypt} onChange={setEncrypt} />
      <p className="opts-summary">
        Each file will
        <span className="badge">
          <Flame aria-hidden />
          expire in {hoursLabel(ttl)}
        </span>
        <span className="badge">
          <Download aria-hidden />
          {maxDownloads === 0 ? "unlimited downloads" : `${maxDownloads} download${maxDownloads === 1 ? "" : "s"}`}
        </span>
        <span className="badge" data-tone={encrypt ? "ice" : undefined}>
          {encrypt ? <Lock aria-hidden /> : <LockOpen aria-hidden />}
          {encrypt ? "encrypted" : "not encrypted"}
        </span>
      </p>
    </section>
  );
}
