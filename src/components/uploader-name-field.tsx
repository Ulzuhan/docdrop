"use client";

import { useState, useSyncExternalStore } from "react";
import { UserRound } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getUploaderName, setUploaderName } from "@/lib/uploader-name";

const noopSubscribe = () => () => {};

/**
 * The name your uploads are labelled with.
 *
 * When several people share the same service, without this the listing is just a
 * pile of ownerless files. Stored in the browser, so it is typed once.
 */
export function UploaderNameField() {
  // The value lives in localStorage, which does not exist during server rendering:
  // it is read after hydration, with no setState inside an effect.
  const stored = useSyncExternalStore(
    noopSubscribe,
    () => getUploaderName(),
    () => ""
  );
  const [edited, setEdited] = useState<string | null>(null);
  const name = edited ?? stored;

  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="uploader" className="flex items-center gap-1.5 text-muted-foreground">
        <UserRound className="size-3.5" aria-hidden />
        <span className="sr-only sm:not-sr-only">Upload as</span>
      </Label>
      <Input
        id="uploader"
        value={name}
        onChange={(e) => {
          setEdited(e.target.value);
          setUploaderName(e.target.value);
        }}
        placeholder="your name"
        maxLength={40}
        autoComplete="nickname"
        className="h-9 w-32 text-sm sm:w-40"
      />
    </div>
  );
}
