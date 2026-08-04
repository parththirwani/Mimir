import { motion, useInView } from "motion/react";
import { useRef } from "react";

const lines = [
  { role: "you", text: "Ping me if Dana replies about the pilot contract." },
  { role: "mimir", text: "Holding that. I'll watch her thread." },
  { role: "mimir", text: "Dana replied. She wants the start date moved to the 14th." },
  { role: "you", text: "Is that the same pilot I asked you to track last week?" },
  {
    role: "mimir",
    text: "I think so — same account, different doc. Confirm before I merge them?",
  },
];

/** The thread plays out message-by-message as the section scrolls into view. */
export function ThreadDemo() {
  const ref = useRef<HTMLDivElement | null>(null);
  const inView = useInView(ref, { once: true, amount: 0.3 });

  return (
    <div
      ref={ref}
      className="rounded-lg border border-border bg-card/40 p-4 backdrop-blur-sm sm:p-6"
    >
      <ul className="divide-y divide-border">
        {lines.map((line, index) => (
          <motion.li
            key={line.text}
            className="flex gap-4 py-4 sm:gap-6"
            initial={{ opacity: 0, y: 10 }}
            animate={inView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.5, delay: index * 0.3, ease: [0.16, 1, 0.3, 1] }}
          >
            <span className="w-14 shrink-0 pt-0.5 text-xs tracking-widest text-muted-foreground uppercase">
              {line.role === "you" ? "You" : "Mimir"}
            </span>
            <span
              className={
                line.role === "you"
                  ? "leading-relaxed text-foreground"
                  : "leading-relaxed text-muted-foreground"
              }
            >
              {line.text}
            </span>
          </motion.li>
        ))}
      </ul>
      <motion.div
        className="flex items-center gap-2 pt-4 text-xs text-muted-foreground"
        initial={{ opacity: 0 }}
        animate={inView ? { opacity: 1 } : {}}
        transition={{ delay: lines.length * 0.3 + 0.2, duration: 0.5 }}
      >
        <motion.span
          className="h-1.5 w-1.5 rounded-full bg-signal"
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
        />
        Still watching — nothing else worth telling you yet.
      </motion.div>
    </div>
  );
}
