import { CircleCheck, CircleX, Info, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dismiss, useToasts } from "@/lib/toast";

const ICONS = { success: CircleCheck, error: CircleX, info: Info } as const;

export function Toaster() {
  const toasts = useToasts();
  return (
    <div className="toaster" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div key={t.id} className="toast" data-kind={t.kind} role="status">
            <span className="toast-icon" aria-hidden>
              <Icon />
            </span>
            <div className="toast-body">
              <strong>{t.title}</strong>
              {t.description && <span>{t.description}</span>}
            </div>
            <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <X />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
