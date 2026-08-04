import { motion } from "motion/react";
import { Sparkles, type LucideIcon } from "lucide-react";

type Mark = { name: string; icon: LucideIcon };

/**
 * Integration marks on either side, with beams of light drifting inward
 * toward the central Mimir node — data quietly flowing in.
 */
export function FlowBeams({ marks }: { marks: Mark[] }) {
  const left = marks.slice(0, 3);
  const right = marks.slice(3, 6);

  const paths = [
    "M0 30 C 110 30, 120 130, 196 130",
    "M0 130 C 90 130, 110 130, 196 130",
    "M0 230 C 110 230, 120 130, 196 130",
    "M400 30 C 290 30, 280 130, 204 130",
    "M400 130 C 310 130, 290 130, 204 130",
    "M400 230 C 290 230, 280 130, 204 130",
  ];

  return (
    <div className="relative">
      <svg
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 400 260"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="beam" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--signal)" stopOpacity="0" />
            <stop offset="50%" stopColor="var(--signal)" stopOpacity="0.85" />
            <stop offset="100%" stopColor="var(--signal)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {paths.map((d, index) => (
          <g key={d}>
            <path d={d} fill="none" stroke="var(--color-border-strong)" strokeWidth="1" />
            <motion.path
              d={d}
              fill="none"
              stroke="url(#beam)"
              strokeWidth="1.5"
              strokeLinecap="round"
              pathLength={1}
              strokeDasharray="0.16 0.84"
              initial={{ strokeDashoffset: 1 }}
              animate={{ strokeDashoffset: [1, -0.16] }}
              transition={{
                duration: 5.5,
                repeat: Infinity,
                ease: "linear",
                delay: index * 0.85,
              }}
            />
          </g>
        ))}
      </svg>

      <div className="relative grid grid-cols-[1fr_auto_1fr] items-center gap-4 py-4 sm:gap-10">
        <Column marks={left} align="start" />
        <Node />
        <Column marks={right} align="end" />
      </div>
    </div>
  );
}

function Column({ marks, align }: { marks: Mark[]; align: "start" | "end" }) {
  return (
    <div
      className={
        "flex flex-col gap-14 sm:gap-16 " + (align === "end" ? "items-end" : "items-start")
      }
    >
      {marks.map((mark, index) => (
        <motion.span
          key={mark.name}
          initial={{ opacity: 0, x: align === "end" ? 12 : -12 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.5, delay: index * 0.1, ease: [0.16, 1, 0.3, 1] }}
          className="flex items-center gap-2 rounded-md border border-border bg-card/60 px-3 py-2 text-sm text-muted-foreground backdrop-blur-sm transition-colors duration-300 hover:border-border-strong hover:text-foreground"
        >
          <mark.icon className="h-4 w-4 shrink-0" aria-hidden="true" strokeWidth={1.5} />
          <span className="hidden sm:inline">{mark.name}</span>
        </motion.span>
      ))}
    </div>
  );
}

function Node() {
  return (
    <div className="relative flex h-24 w-24 items-center justify-center sm:h-28 sm:w-28">
      <motion.span
        aria-hidden="true"
        className="absolute inset-0 rounded-full"
        style={{
          background:
            "radial-gradient(circle, color-mix(in oklab, var(--signal) 22%, transparent), transparent 70%)",
        }}
        animate={{ opacity: [0.4, 0.85, 0.4], scale: [0.95, 1.08, 0.95] }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
      />
      <div className="relative flex h-16 w-16 items-center justify-center rounded-full border border-border-strong bg-background sm:h-20 sm:w-20">
        <Sparkles className="h-6 w-6 text-foreground" aria-hidden="true" strokeWidth={1.5} />
      </div>
    </div>
  );
}
