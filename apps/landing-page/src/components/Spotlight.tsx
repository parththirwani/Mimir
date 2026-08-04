import { motion } from "motion/react";
import { cn } from "@/lib/utils";

/** Soft, slowly drifting radial glow. Purely decorative depth. */
export function Spotlight({
  className,
  size = "60% 50% at 50% 40%",
  strength = 12,
  duration = 22,
}: {
  className?: string;
  size?: string;
  strength?: number;
  duration?: number;
}) {
  return (
    <motion.div
      aria-hidden="true"
      className={cn("pointer-events-none absolute", className)}
      style={{
        background: `radial-gradient(${size}, color-mix(in oklab, var(--signal) ${strength}%, transparent), transparent 70%)`,
      }}
      initial={{ opacity: 0 }}
      animate={{
        opacity: [0.55, 0.9, 0.55],
        x: ["-3%", "3%", "-3%"],
        y: ["-2%", "2%", "-2%"],
        scale: [1, 1.06, 1],
      }}
      transition={{ duration, repeat: Infinity, ease: "easeInOut" }}
    />
  );
}
