import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

const scattered = [
  "Gmail — 3 unread from Dana",
  "Slack #pilot — 41 new",
  "Notion — Pilot scope (edited 1h ago)",
  "Linear — MIG-204 blocked",
  "GitHub — PR #812 awaiting review",
  "Calendar — 4 conflicts today",
];

const continuous = [
  "Dana moved the start date to the 14th.",
  "The scope doc already answers the Slack thread.",
  "PR #812 is approved — MIG-204 is ready to ship.",
];

/** Drag to compare: scattered surfaces vs. one continuous thread. */
export function Compare({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [value, setValue] = useState(52);

  const move = (clientX: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    setValue(Math.min(96, Math.max(4, ((clientX - rect.left) / rect.width) * 100)));
  };

  return (
    <div
      ref={ref}
      className={cn(
        "relative h-[22rem] w-full cursor-ew-resize overflow-hidden rounded-lg border border-border bg-card/40 select-none sm:h-[24rem]",
        className,
      )}
      onMouseMove={(event) => event.buttons === 1 && move(event.clientX)}
      onMouseDown={(event) => move(event.clientX)}
      onTouchMove={(event) => {
        const touch = event.touches[0];
        if (touch) move(touch.clientX);
      }}
    >
      {/* After: one continuous thread */}
      <div className="absolute inset-0 flex flex-col items-end justify-center gap-4 p-8 text-right sm:p-10">
        <span className="text-xs tracking-widest text-signal uppercase">One thread</span>
        {continuous.map((line) => (
          <p key={line} className="max-w-sm leading-relaxed text-foreground">
            {line}
          </p>
        ))}
      </div>

      {/* Before: scattered surfaces */}
      <div
        className="absolute inset-0 bg-background p-8 sm:p-10"
        style={{ clipPath: `inset(0 ${100 - value}% 0 0)` }}
      >
        <span className="text-xs tracking-widest text-muted-foreground uppercase">
          Everywhere else
        </span>
        <div className="mt-5 grid gap-2.5">
          {scattered.map((line) => (
            <span
              key={line}
              className="w-fit rounded-md border border-border px-3 py-1.5 text-sm whitespace-nowrap text-muted-foreground"
            >
              {line}
            </span>
          ))}
        </div>
      </div>

      <div
        className="pointer-events-none absolute inset-y-0 w-px bg-border-strong"
        style={{ left: `${value}%` }}
      >
        <span className="absolute top-1/2 left-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border-strong bg-background text-xs text-muted-foreground">
          ↔
        </span>
      </div>
    </div>
  );
}
