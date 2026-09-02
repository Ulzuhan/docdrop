"use client";

import { Lock, LockOpen } from "lucide-react";

/**
 * Whether the next uploads are encrypted in the browser.
 *
 * On by default and asked every time, because the safe setting should not
 * depend on what somebody picked another day. Off is a real choice with a
 * real price, and the control says it: the server can then read the file —
 * which is also why it can preview it, zip it and hand it to whoever holds the
 * link without any key to lose.
 */
export function EncryptionChoice({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (encrypt: boolean) => void;
}) {
  const options = [
    { value: true, label: "In your browser", icon: Lock },
    { value: false, label: "Off", icon: LockOpen },
  ] as const;
  return (
    <div>
      <span id="encrypt-label" className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Lock className="size-3.5" aria-hidden />
        Encryption
      </span>
      <div
        role="radiogroup"
        aria-labelledby="encrypt-label"
        className="mt-1.5 grid grid-cols-2 gap-1.5 rounded-xl bg-muted/60 p-1"
      >
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            onClick={() => onChange(option.value)}
            className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-sm font-medium transition-all ${
              value === option.value
                ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <option.icon className="size-3.5" aria-hidden />
            {option.label}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {value
          ? "The key travels in the link and this server cannot open the file. Lose the link, lose the file."
          : "This server can read the file. In return it can preview it, zip it, and the link has no key to lose."}
      </p>
    </div>
  );
}
