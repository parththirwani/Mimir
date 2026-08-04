import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

function useInView<T extends HTMLElement>(once = true) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            if (once) io.disconnect();
          } else if (!once) {
            setInView(false);
          }
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [once]);

  return { ref, inView };
}

/** Single element that reveals on scroll: opacity 0→1, translateY(14px)→0. */
export function Reveal({
  children,
  delay = 0,
  className,
  as: Tag = "div",
}: {
  children: ReactNode;
  delay?: number | undefined;
  className?: string | undefined;
  as?: "div" | "section" | "p" | "span" | "li" | undefined;
}) {
  const { ref, inView } = useInView<HTMLDivElement>();
  return (
    <Tag
      ref={ref as never}
      className={className}
      style={{
        opacity: inView ? 1 : 0,
        transform: inView ? "translateY(0)" : "translateY(14px)",
        transition: `opacity 560ms ${EASE} ${delay}ms, transform 560ms ${EASE} ${delay}ms`,
      }}
    >
      {children}
    </Tag>
  );
}

/** Staggers direct <Item> children using the same motion signature. */
export function Stagger({
  children,
  step = 90,
  className,
}: {
  children: ReactNode;
  step?: number | undefined;
  className?: string | undefined;
}) {
  return (
    <div className={className} style={{ ["--stagger-step" as string]: `${step}ms` }}>
      {children}
    </div>
  );
}

export function Item({
  children,
  index = 0,
  step = 90,
  className,
}: {
  children: ReactNode;
  index?: number | undefined;
  step?: number | undefined;
  className?: string | undefined;
}) {
  return (
    <Reveal delay={index * step} className={className}>
      {children}
    </Reveal>
  );
}

/**
 * Word-by-word reveal for Mimir's replies. Same easing/duration as .reveal.
 * Calls onDone once every word has landed.
 */
export function TextGenerate({
  text,
  className,
  wordDelay = 55,
  onDone,
  active = true,
}: {
  text: string;
  className?: string | undefined;
  wordDelay?: number | undefined;
  onDone?: (() => void) | undefined;
  active?: boolean | undefined;
}) {
  const words = text.split(" ");
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (!active) return;
    const total = words.length * wordDelay + 560;
    const t = setTimeout(() => doneRef.current?.(), total);
    return () => clearTimeout(t);
  }, [active, text, wordDelay, words.length]);

  if (!active) return <span className={className}>{text}</span>;

  return (
    <span className={className}>
      {words.map((word, i) => (
        <span
          key={`${word}-${i}`}
          className="inline-block whitespace-pre"
          style={{
            animation: `reveal-in 500ms ${EASE} ${i * wordDelay}ms both`,
          }}
        >
          {word}
          {i < words.length - 1 ? " " : ""}
        </span>
      ))}
    </span>
  );
}

/** The pulsing signal dot — the one loading/liveness indicator in the product. */
export function SignalDot({ className }: { className?: string | undefined }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full bg-signal animate-signal-pulse", className)}
    />
  );
}
