import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, ArrowUp } from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import { Spotlight } from "@/components/spotlight";
import { MovingBorderButton } from "@/components/moving-border-button";
import { Reveal, SignalDot } from "@/components/motion";
import { ThreadBubbles } from "@/components/thread-bubbles";
import { ConnectorsPanel } from "@/components/connectors-panel";
import { integrations as seedIntegrations } from "@/lib/integrations";
import { seedThread, type ThreadMessage } from "@/lib/thread";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/chat")({
  head: () => ({
    meta: [
      { title: "Your thread — Mimir" },
      {
        name: "description",
        content:
          "One continuous thread with Mimir. Tell it what you're waiting on once, and it keeps watching.",
      },
      { property: "og:title", content: "Your thread — Mimir" },
      {
        property: "og:description",
        content: "Tell Mimir what you're waiting on once. It keeps watching and tells you when it moves.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ChatPage,
});

const REPLIES = [
  "Got it. I'll watch for it and tell you the moment something changes — you don't need to ask again.",
  "Noted. Nothing there yet, but it's on my list now and I'll surface it the second it moves.",
  "Understood. I'll keep it alongside the Ridgeline thread and only interrupt you when it matters.",
];

function ChatPage() {
  const [messages, setMessages] = useState<ThreadMessage[]>(seedThread);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [listening, setListening] = useState(false);
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const [connectors, setConnectors] = useState(seedIntegrations);
  const [streamingId, setStreamingId] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const replyIndex = useRef(0);

  const isEmpty = messages.length === 0;

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, thinking]);

  const autosize = useCallback(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 168)}px`;
  }, []);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || thinking) return;

    const userMessage: ThreadMessage = { id: `u-${Date.now()}`, speaker: "you", text };
    setMessages((prev) => [...prev, userMessage]);
    setDraft("");
    setListening(false);
    setThinking(true);
    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      textareaRef.current?.focus();
    });

    const reply = REPLIES[replyIndex.current % REPLIES.length]!;
    replyIndex.current += 1;

    window.setTimeout(() => {
      const id = `m-${Date.now()}`;
      setThinking(false);
      setStreamingId(id);
      setMessages((prev) => [...prev, { id, speaker: "mimir", text: reply }]);
      textareaRef.current?.focus();
    }, 900);
  }, [draft, thinking]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <SiteHeader
        watching={connectors.filter((c) => c.connected).map((c) => c.name)}
        onOpenConnectors={() => setConnectorsOpen(true)}
      />

      <ConnectorsPanel
        open={connectorsOpen}
        onClose={() => setConnectorsOpen(false)}
        items={connectors}
        onConnect={(name) =>
          setConnectors((prev) =>
            prev.map((c) => (c.name === name ? { ...c, connected: true } : c)),
          )
        }
      />

      <main className="relative flex-1 overflow-y-auto">
        <div className="pointer-events-none absolute inset-0 grid-texture opacity-40" aria-hidden />

        {isEmpty ? (
          <FirstVisit />
        ) : (
          <div className="relative mx-auto w-full max-w-2xl px-5 pb-16 pt-14">
            <h1 className="sr-only">Your thread with Mimir</h1>
            <ThreadBubbles
              messages={messages}
              streamingId={streamingId}
              onStreamDone={() => setStreamingId(null)}
            />

            <div className="flex items-center gap-2 pt-6">
              <SignalDot />
              <span className="text-xs text-muted-foreground">
                {thinking
                  ? "Thinking it through."
                  : streamingId
                    ? "Telling you now."
                    : "Still watching — nothing else worth telling you yet."}
              </span>
            </div>
            <div ref={bottomRef} />
          </div>
        )}
      </main>

      <div className="z-20 shrink-0 border-t border-border bg-background/90 backdrop-blur-md">
        <div className="mx-auto w-full max-w-2xl px-5 py-4">
          <div className="flex items-end gap-2">
            <button
              type="button"
              aria-label={listening ? "Stop voice input" : "Start voice input"}
              aria-pressed={listening}
              onClick={() => setListening((v) => !v)}
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-md border border-transparent",
                "text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
                "focus-visible:outline-none focus-visible:border-signal",
                listening && "text-signal",
              )}
            >
              {listening ? <Waveform /> : <Mic className="size-4" />}
            </button>

            <textarea
              ref={textareaRef}
              rows={1}
              value={draft}
              placeholder="Tell it something once."
              onChange={(event) => {
                setDraft(event.target.value);
                autosize();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
              className={cn(
                "min-h-9 flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2",
                "font-sans text-[0.95rem] leading-6 text-foreground placeholder:text-muted-foreground",
                "outline-none transition-colors focus:border-signal",
              )}
            />

            <MovingBorderButton
              onClick={send}
              disabled={thinking || draft.trim().length === 0}
              aria-label="Send"
              className="px-3 py-2"
            >
              {thinking ? <SignalDot /> : <ArrowUp className="size-4" />}
            </MovingBorderButton>
          </div>
          <p className="mt-2 pl-11 text-xs text-muted-foreground">
            {listening
              ? "Listening — speak, it goes into the same thread."
              : "One thread. No folders, no starting over."}
          </p>
        </div>
      </div>
    </div>
  );
}

function Waveform() {
  return (
    <span aria-hidden className="flex h-4 items-center gap-[2px]">
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className="w-[2px] rounded-full bg-signal"
          style={{
            height: "100%",
            animation: `waveform 1s ease-in-out ${i * 120}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}

function FirstVisit() {
  return (
    <div className="relative flex min-h-[60vh] items-center justify-center px-5">
      <Spotlight />
      <Reveal className="relative max-w-md text-center">
        <h1 className="font-condensed text-3xl font-semibold text-foreground sm:text-4xl">
          Say the first thing.
        </h1>
        <p className="mx-auto mt-4 max-w-sm text-[0.95rem] leading-7 text-muted-foreground">
          There's nothing to set up. Just tell it what you're waiting on.
        </p>
      </Reveal>
    </div>
  );
}
