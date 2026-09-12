/**
 * Getting files into the page: a drop anywhere on the window, a paste, or the
 * pickers. Folders dropped from the desktop are walked into their files.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** Pulls the files out of a drop, walking into folders when there are any. */
export async function filesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
  const entries = Array.from(dataTransfer.items)
    .map((item) => (item.kind === "file" ? item.webkitGetAsEntry?.() : null))
    .filter(Boolean) as FileSystemEntry[];

  if (entries.length === 0) return Array.from(dataTransfer.files);

  const out: File[] = [];
  async function walk(entry: FileSystemEntry): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) =>
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null))
      );
      if (file) out.push(file);
      return;
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries hands back at most 100 per call: keep asking until empty.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve) =>
          reader.readEntries(resolve, () => resolve([]))
        );
        if (batch.length === 0) break;
        for (const child of batch) await walk(child);
      }
    }
  }
  for (const entry of entries) await walk(entry);
  return out;
}

function carriesFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  return Boolean(types && Array.from(types).includes("Files"));
}

/**
 * The whole window is the drop target. Returns whether a file drag is in
 * progress so the page can show it. A depth counter keeps the flag steady while
 * the cursor crosses child elements, which fire their own enter/leave pairs.
 */
export function useWindowDrop(onFiles: (files: File[]) => void, enabled = true): boolean {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const handler = useRef(onFiles);
  useEffect(() => {
    handler.current = onFiles;
  }, [onFiles]);

  useEffect(() => {
    if (!enabled) return;
    function onEnter(event: DragEvent) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    }
    function onOver(event: DragEvent) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
    function onLeave(event: DragEvent) {
      if (!carriesFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    }
    function onDrop(event: DragEvent) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      void filesFromDataTransfer(event.dataTransfer!).then((files) => {
        if (files.length > 0) handler.current(files);
      });
    }
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [enabled]);

  return dragging;
}

/** A screenshot pasted from the clipboard is a file too. */
export function usePasteFiles(onFiles: (files: File[]) => void, enabled = true) {
  const handler = useRef(onFiles);
  useEffect(() => {
    handler.current = onFiles;
  }, [onFiles]);
  useEffect(() => {
    if (!enabled) return;
    function onPaste(event: ClipboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      handler.current(files);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [enabled]);
}

/** Hidden `<input type=file>` pair: files, and a folder where supported. */
export function usePickers(onFiles: (files: File[]) => void) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const openFiles = useCallback(() => fileInput.current?.click(), []);
  const openFolder = useCallback(() => folderInput.current?.click(), []);
  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      onFiles(Array.from(event.target.files ?? []));
      event.target.value = "";
    },
    [onFiles]
  );
  return { fileInput, folderInput, openFiles, openFolder, onChange };
}
