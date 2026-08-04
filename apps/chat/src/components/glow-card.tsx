import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Hairline card surface with a faint interior glow. No drop shadows. */
export function GlowCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border border-border bg-card p-6",
        "transition-colors duration-300 hover:border-border-strong",
        className,
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 left-1/2 h-48 w-64 -translate-x-1/2 opacity-60"
        style={{
          background: "radial-gradient(closest-side, oklch(1 0 0 / 6%), transparent 75%)",
        }}
      />
      <div className="relative">{children}</div>
    </div>
  );
}
