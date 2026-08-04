import { cn } from "@/lib/utils";

/**
 * Soft radial glow used behind the hero and the chat's first-visit state.
 * Pure greyscale + a whisper of signal — no new gradients beyond this.
 */
export function Spotlight({ className }: { className?: string | undefined }) {
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
    >
      <div
        className="absolute left-1/2 top-0 h-[38rem] w-[52rem] -translate-x-1/2 -translate-y-1/3 opacity-70"
        style={{
          background:
            "radial-gradient(closest-side, oklch(1 0 0 / 9%), oklch(1 0 0 / 3%) 45%, transparent 72%)",
        }}
      />
      <div
        className="absolute left-1/2 top-10 h-[22rem] w-[26rem] -translate-x-1/2 opacity-40"
        style={{
          background:
            "radial-gradient(closest-side, color-mix(in oklch, var(--signal) 22%, transparent), transparent 70%)",
        }}
      />
    </div>
  );
}
