import { Reveal, TextGenerate, SignalDot } from "@/components/motion";
import { seedThread, type ThreadMessage } from "@/lib/thread";

function SpeakerLabel({ speaker }: { speaker: ThreadMessage["speaker"] }) {
  return (
    <div className="w-16 shrink-0 pt-0.5 text-xs uppercase tracking-widest text-muted-foreground">
      {speaker === "you" ? "You" : "Mimir"}
    </div>
  );
}

export function ThreadDemo() {
  return (
    <div className="divide-y divide-border rounded-md border border-border bg-card">
      {seedThread.slice(0, 3).map((message, index) => (
        <Reveal key={message.id} delay={index * 120} className="px-5 py-5">
          {message.divider ? (
            <div className="mb-4 flex items-center gap-3">
              <span className="label-eyebrow">{message.divider}</span>
              <span className="h-px flex-1 bg-border" />
            </div>
          ) : null}
          <div className="flex gap-4">
            <SpeakerLabel speaker={message.speaker} />
            <p
              className={`text-[0.95rem] leading-7 ${
                message.speaker === "you" ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              {message.speaker === "mimir" && index === 2 ? (
                <TextGenerate text={message.text} />
              ) : (
                message.text
              )}
            </p>
          </div>
        </Reveal>
      ))}
      <div className="flex items-center gap-2 px-5 py-4">
        <SignalDot />
        <span className="text-xs text-muted-foreground">
          Still watching — nothing else worth telling you yet.
        </span>
      </div>
    </div>
  );
}
