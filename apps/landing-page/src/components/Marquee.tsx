import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Continuous horizontal drift. Duplicates children for a seamless loop. */
export function Marquee({
  children,
  className,
  duration = 40,
  reverse = false,
}: {
  children: ReactNode;
  className?: string;
  duration?: number;
  reverse?: boolean;
}) {
  return (
    <div className={cn("marquee-mask relative overflow-hidden", className)}>
      <div
        className="flex w-max"
        style={{
          animation: `marquee ${duration}s linear infinite${reverse ? " reverse" : ""}`,
        }}
      >
        <div className="flex shrink-0 items-stretch">{children}</div>
        <div className="flex shrink-0 items-stretch" aria-hidden="true">
          {children}
        </div>
      </div>
    </div>
  );
}
