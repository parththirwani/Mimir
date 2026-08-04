import { cn } from "@/lib/utils";

/** The Mimir mark: circle in circle. */
export function MimirMark({ className }: { className?: string | undefined }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-5 items-center justify-center rounded-full border border-border-strong",
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-signal" />
    </span>
  );
}
