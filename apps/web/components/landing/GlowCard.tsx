import { useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { fadeScale } from "@/components/landing/motion";

/** Bento card with a cursor-following border-light glow. */
export function GlowCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  return (
    <motion.div
      ref={ref}
      variants={fadeScale}
      onMouseMove={(event) => {
        const rect = ref.current?.getBoundingClientRect();
        if (!rect) return;
        setPos({ x: event.clientX - rect.left, y: event.clientY - rect.top });
      }}
      onMouseLeave={() => setPos(null)}
      className={cn(
        "group relative overflow-hidden rounded-lg border border-border bg-card/40 p-8 transition-colors duration-300 hover:border-border-strong sm:p-10",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background: pos
            ? `radial-gradient(340px circle at ${pos.x}px ${pos.y}px, color-mix(in oklab, var(--signal) 9%, transparent), transparent 65%)`
            : undefined,
        }}
      />
      <div className="relative flex h-full flex-col">{children}</div>
    </motion.div>
  );
}
