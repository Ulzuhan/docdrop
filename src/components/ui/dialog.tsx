import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cx } from "@/lib/cx";

interface Props {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: ReactNode;
  size?: "sm" | "md";
  children?: ReactNode;
}

/**
 * A modal on the native <dialog> element: the browser gives the focus trap,
 * Escape, the top layer and the backdrop. Clicking the backdrop closes it.
 * Content mounts when it opens, so a panel starts fresh every time.
 */
export function Dialog({ open, onClose, title, description, size = "md", children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={cx("dialog", size === "sm" && "dialog-sm")}
      aria-labelledby={title ? titleId : undefined}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {open && (
        <div className="dialog-panel">
          {(title || description) && (
            <div className="dialog-head">
              <div>
                {title && <h2 id={titleId}>{title}</h2>}
                {description && <p>{description}</p>}
              </div>
              <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
                <X />
              </Button>
            </div>
          )}
          {children}
        </div>
      )}
    </dialog>
  );
}
