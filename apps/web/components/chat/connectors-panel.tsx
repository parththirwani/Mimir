import { useEffect } from "react";
import { X } from "lucide-react";
import type { Integration } from "@/lib/integrations";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onClose: () => void;
  onConnect: (name: string) => void;
  items: Integration[];
  onLogout?: () => void;
};

export function ConnectorsPanel({ open, onClose, onConnect, items, onLogout }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40">
      <button
        type="button"
        aria-label="Close connectors"
        onClick={onClose}
        className="backdrop-fade absolute inset-0 bg-background/60 backdrop-blur-[1px]"
      />
      <aside
        role="dialog"
        aria-label="Connectors"
        className={cn(
          "panel-slide absolute inset-y-0 right-0 flex w-full flex-col border-l border-border bg-card",
          "sm:w-[380px]",
        )}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
          <h2 className="font-condensed text-lg font-semibold text-foreground">Connectors</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close connectors"
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:border focus-visible:border-signal"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <ul className="divide-y divide-border border-b border-border">
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.name} className="flex items-center gap-3 px-5 py-3.5">
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="flex-1 text-sm font-medium text-foreground">{item.name}</span>
                  {item.connected ? (
                    <span className="flex items-center gap-2">
                      <span className="size-1.5 rounded-full bg-signal" aria-hidden />
                      <span className="text-xs text-muted-foreground">Connected</span>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onConnect(item.name)}
                      className={cn(
                        "flex items-center gap-2 rounded-md border border-border bg-secondary px-3 py-1.5 text-xs font-medium text-foreground",
                        "transition-colors hover:border-border-strong hover:bg-accent",
                        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal",
                      )}
                    >
                      <span
                        className="size-1.5 rounded-full border border-muted-foreground"
                        aria-hidden
                      />
                      Connect
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="px-5 py-4 text-xs leading-5 text-muted-foreground">
            Revoke access to any connector at any time. Nothing is watched after you disconnect it.
          </p>
          {onLogout ? (
            <div className="border-t border-border p-4">
              <button
                type="button"
                onClick={onLogout}
                className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:border-signal"
              >
                Log out
              </button>
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
