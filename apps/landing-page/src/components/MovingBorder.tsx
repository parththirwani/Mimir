import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Primary CTA with a slow rotating gradient hairline border. */
export function MovingBorderLink({
  children,
  href,
  className,
}: {
  children: ReactNode;
  href: string;
  className?: string;
}) {
  return (
    <a href={href} className={cn("moving-border group relative inline-flex", className)}>
      <span className="relative z-10 inline-flex items-center rounded-[calc(var(--radius)-1px)] bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-transform duration-200 group-hover:scale-[1.015]">
        {children}
      </span>
    </a>
  );
}

export function MovingBorderButton({
  children,
  className,
  type = "submit",
}: {
  children: ReactNode;
  className?: string;
  type?: "submit" | "button";
}) {
  return (
    <button type={type} className={cn("moving-border group relative inline-flex", className)}>
      <span className="relative z-10 inline-flex w-full items-center justify-center rounded-[calc(var(--radius)-1px)] bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-transform duration-200 group-hover:scale-[1.015]">
        {children}
      </span>
    </button>
  );
}
