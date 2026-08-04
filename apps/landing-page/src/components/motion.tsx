import { motion, useInView, type Variants } from "motion/react";
import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const EASE = [0.16, 1, 0.3, 1] as const;

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.56, ease: EASE } },
};

export const fadeScale: Variants = {
  hidden: { opacity: 0, y: 16, scale: 0.97 },
  show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.6, ease: EASE } },
};

/** Wraps a section; children with `variants` animate in a stagger once in view. */
export function Stagger({
  children,
  className,
  gap = 0.1,
  amount = 0.2,
  delay = 0,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  gap?: number;
  amount?: number;
  delay?: number;
  as?: "div" | "section" | "ul" | "header" | "footer";
}) {
  const Comp = motion[as];
  return (
    <Comp
      className={className}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, amount }}
      variants={{ show: { transition: { staggerChildren: gap, delayChildren: delay } } }}
    >
      {children}
    </Comp>
  );
}

export function Item({
  children,
  className,
  variant = "fade",
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  variant?: "fade" | "scale";
  as?: "div" | "h1" | "h2" | "h3" | "p" | "li" | "span";
}) {
  const Comp = motion[as];
  return (
    <Comp className={className} variants={variant === "scale" ? fadeScale : fadeUp}>
      {children}
    </Comp>
  );
}

/** Word-by-word reveal for headlines. Renders <br /> for "\n". */
export function TextGenerate({
  text,
  className,
  delay = 0.15,
}: {
  text: string;
  className?: string;
  delay?: number;
}) {
  const words = text.split(" ");
  return (
    <motion.span
      className={cn("inline", className)}
      initial="hidden"
      animate="show"
      variants={{ show: { transition: { staggerChildren: 0.055, delayChildren: delay } } }}
      aria-label={text.replace(/\n/g, " ")}
    >
      {words.map((word, index) =>
        word === "\n" ? (
          <br key={`br-${index}`} />
        ) : (
          <motion.span
            key={`${word}-${index}`}
            className="inline-block"
            variants={{
              hidden: { opacity: 0, y: "0.35em", filter: "blur(6px)" },
              show: {
                opacity: 1,
                y: 0,
                filter: "blur(0px)",
                transition: { duration: 0.6, ease: EASE },
              },
            }}
          >
            {word}
            {"\u00A0"}
          </motion.span>
        ),
      )}
    </motion.span>
  );
}

/** Sequenced message list — each row lands ~300ms after the previous, once in view. */
export function useSequenceInView() {
  const ref = useRef<HTMLDivElement | null>(null);
  const inView = useInView(ref, { once: true, amount: 0.3 });
  return { ref, inView };
}

export { motion, EASE };
