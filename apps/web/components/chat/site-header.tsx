import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { MimirMark } from "@/components/chat/mimir-mark";
import { SignalDot } from "@/components/chat/motion";
import { watchingLabel } from "@/lib/integrations";

export function SiteHeader({
  watching,
  onOpenConnectors,
  onLogout,
}: {
  watching?: string[] | undefined;
  onOpenConnectors?: (() => void) | undefined;
  onLogout?: (() => void) | undefined;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-5">
        <Link href="/chat" className="flex items-center gap-2.5">
          <MimirMark className="size-7" />
          <span className="font-condensed text-base font-semibold text-foreground">Mimir</span>
        </Link>
        {watching ? (
          <div className="flex items-center gap-3">
            <Link
              href="/settings"
              className="rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none"
            >
              Settings
            </Link>
            {onOpenConnectors ? (
              <button
                type="button"
                onClick={onOpenConnectors}
                aria-label="Open connectors"
                className="flex max-w-[60vw] cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:border focus-visible:border-signal"
              >
                {watching.length > 0 ? (
                  <SignalDot />
                ) : (
                  <span
                    className="size-1.5 shrink-0 rounded-full border border-muted-foreground"
                    aria-hidden
                  />
                )}
                <span className="truncate text-xs">{watchingLabel(watching)}</span>
                <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <SignalDot />
                <span className="truncate text-xs text-muted-foreground">
                  {watchingLabel(watching)}
                </span>
              </div>
            )}
            {onLogout ? (
              <button
                type="button"
                onClick={onLogout}
                className="cursor-pointer rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:border focus-visible:border-signal"
              >
                Log out
              </button>
            ) : null}
          </div>
        ) : (
          <Link
            href="/login"
            className="font-condensed text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground"
          >
            Log in
          </Link>
        )}
      </div>
    </header>
  );
}
