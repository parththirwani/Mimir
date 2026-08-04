import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Primary action. A slow rotating conic-gradient hairline in the signal color,
 * used for the landing CTA and the chat composer's send button.
 */
export function MovingBorderButton({
  children,
  className,
  containerClassName,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  containerClassName?: string | undefined;
}) {
  return (
    <button
      {...props}
      className={cn(
        "group relative overflow-hidden rounded-md p-px",
        "disabled:pointer-events-none disabled:opacity-50",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal",
        containerClassName,
      )}
    >
      <span
        aria-hidden
        className="absolute inset-[-120%] animate-border-spin"
        style={{
          background:
            "conic-gradient(from 0deg, transparent 0deg, transparent 300deg, color-mix(in oklch, var(--signal) 85%, transparent) 345deg, transparent 360deg)",
        }}
      />
      <span
        className={cn(
          "relative flex items-center justify-center gap-2 rounded-[calc(var(--radius)-1px)]",
          "border border-border bg-card px-4 py-2 font-condensed text-sm font-semibold text-foreground",
          "transition-colors duration-300 group-hover:bg-secondary",
          className,
        )}
      >
        {children}
      </span>
    </button>
  );
}
