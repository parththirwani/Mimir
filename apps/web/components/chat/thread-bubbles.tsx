import { Reveal } from "@/components/chat/motion";
import { Markdown } from "@/components/chat/markdown";
import type { ThreadMessage } from "@/lib/thread";
import { cn } from "@/lib/utils";

type Props = {
  messages: ThreadMessage[];
  /** The message currently revealing word-by-word, if any. */
  streamingId: string | null;
  /** Called when the streaming message finished revealing. */
  onStreamDone: () => void;
  /** Approve a pending action (e.g. a gmail draft): "send" or "cancel". */
  onAction?: (id: string, action: "send" | "cancel") => void;
};

export function ThreadBubbles({ messages, streamingId, onStreamDone, onAction }: Props) {
  const lastId = messages[messages.length - 1]?.id;

  return (
    <div className="flex flex-col">
      {messages.map((message, index) => {
        const prev = messages[index - 1];
        const isMimir = message.speaker === "mimir";
        const hasDivider = Boolean(message.divider);
        const sameRun = !hasDivider && prev?.speaker === message.speaker;
        const isStreaming = message.id === streamingId && message.id === lastId;

        return (
          <div key={message.id}>
            {hasDivider ? (
              <div className="flex justify-center py-6">
                <span className="rounded-full bg-secondary/50 px-3 py-1 text-xs text-muted-foreground">
                  {message.divider}
                </span>
              </div>
            ) : null}

            <Reveal
              className={cn(
                "group flex flex-col",
                isMimir ? "items-start" : "items-end",
                sameRun ? "mt-1" : hasDivider ? "mt-0" : "mt-5",
              )}
            >
              <div
                className={cn(
                  "max-w-[75%] px-4 py-3 font-sans text-[0.975rem] leading-7 text-foreground",
                  isMimir
                    ? "rounded-2xl rounded-bl-md bg-card"
                    : "rounded-2xl rounded-br-md bg-secondary",
                  sameRun && (isMimir ? "rounded-tl-md" : "rounded-tr-md"),
                )}
              >
                {isMimir ? (
                  <Markdown streaming={isStreaming} onDone={onStreamDone}>
                    {message.text}
                  </Markdown>
                ) : (
                  message.text
                )}
              </div>
              {message.at ? (
                <span className="mt-1 px-1 text-xs text-muted-foreground opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">
                  {message.at}
                </span>
              ) : null}
              {message.actionable && onAction ? (
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => onAction(message.id, "send")}
                    className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:border-signal"
                  >
                    <span className="size-1.5 rounded-full bg-signal" aria-hidden />
                    Send
                  </button>
                  <button
                    type="button"
                    onClick={() => onAction(message.id, "cancel")}
                    className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:border-signal"
                  >
                    <span className="size-1.5 rounded-full border border-muted-foreground" aria-hidden />
                    Cancel
                  </button>
                </div>
              ) : null}
            </Reveal>
          </div>
        );
      })}
    </div>
  );
}
