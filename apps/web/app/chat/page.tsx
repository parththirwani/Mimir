"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Mic, ArrowUp } from "lucide-react";
import { io } from "socket.io-client";
import { SiteHeader } from "@/components/chat/site-header";
import { Spotlight } from "@/components/chat/spotlight";
import { MovingBorderButton } from "@/components/chat/moving-border-button";
import { Reveal, SignalDot } from "@/components/chat/motion";
import { ThreadBubbles } from "@/components/chat/thread-bubbles";
import { ConnectorsPanel } from "@/components/chat/connectors-panel";
import { GmailIcon } from "@/components/landing/brand-icons";
import type { ThreadMessage } from "@/lib/thread";
import { cn } from "@/lib/utils";
import { maybeNotifyDesktop } from "@/lib/push";

const API = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000/api/v1";
const WS_URL = API.replace(/^http/, "ws").replace(/\/api\/v1$/, "");

type View = "loading" | "chat";

interface EmailToolCall {
  type?: string;
  status?: string;
  draft?: { to?: string; subject?: string; body?: string };
}

interface ApiMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  toolCalls?: EmailToolCall | null;
}

interface Conversation {
  conversation: { id: string; messages: ApiMessage[] };
}

function formatAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function toThreadMessage(message: ApiMessage): ThreadMessage {
  return {
    id: message.id,
    speaker: message.role === "user" ? "you" : "mimir",
    text: message.content,
    at: message.createdAt ? formatAt(message.createdAt) : undefined,
    actionable:
      message.toolCalls?.type === "gmail.send_email" && message.toolCalls.status === "pending",
    connectable: message.toolCalls?.type === "gmail.connect" && message.toolCalls.status === "pending",
  };
}

export default function ChatPage() {
  const [view, setView] = useState<View>("loading");
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [listening, setListening] = useState(false);
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gmailConnected, setGmailConnected] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // Message we've already revealed. A refetch must not re-stream the same last
  // message (that's what made replies "reparse" on every socket refetch).
  const lastStreamedRef = useRef<string | null>(null);
  const router = useRouter();

  const isEmpty = messages.length === 0;

  const refreshGmailStatus = useCallback(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${API}/integrations/gmail`, {
        credentials: "include",
      }).catch(() => null);
      if (res && res.ok) {
        const data = (await res.json()) as { connected: boolean };
        setGmailConnected(data.connected);
        if (data.connected) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }, []);

  const refreshThread = useCallback(async (): Promise<boolean> => {
    const res = await fetch(`${API}/conversation`, { credentials: "include" });
    if (res.status === 401) {
      router.replace("/login");
      return false;
    }
    if (!res.ok) return false;
    const data = (await res.json()) as Conversation;
    setConversationId(data.conversation.id);
    const thread = data.conversation.messages.map(toThreadMessage);
    setMessages(thread);
    const last = thread[thread.length - 1];
    if (last?.speaker === "mimir" && last.id !== lastStreamedRef.current) {
      setStreamingId(last.id);
    }
    setView("chat");
    return true;
  }, [router]);

  useEffect(() => {
    refreshThread();
  }, [refreshThread]);

  useEffect(() => {
    if (view !== "chat") return;
    refreshGmailStatus();
  }, [view, refreshGmailStatus]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, thinking]);

  useEffect(() => {
    if (view !== "chat") return;
    // Long-lived push channel: the browser's live socket. Auth rides the
    // httpOnly access_token cookie on the handshake.
    const socket = io(WS_URL, { withCredentials: true });
    let refreshing = false;
    socket.on("connect", () => console.log("[socket] connected", socket.id));
    socket.on("new_message", () => {
      void maybeNotifyDesktop("Mimir", "New activity in your thread");
      fetch(`${API}/conversation`, { credentials: "include" })
        .then((res) => (res.ok ? (res.json() as Promise<Conversation>) : null))
        .then((data) => {
          if (!data) return;
          setConversationId(data.conversation.id);
          setMessages(data.conversation.messages.map(toThreadMessage));
        })
        .catch((err) => console.error("[socket] conversation refetch failed", err));
    });
    socket.on("connect_error", (err) => {
      // Only a rejected handshake means the access token is bad. Refresh at most one
      // at a time: /auth/refresh rotates the token, so concurrent refreshes from
      // multiple tabs sharing the cookie race.
      const isAuthError = String(err?.message).toLowerCase().includes("unauthorized");
      if (!isAuthError || refreshing) return;
      refreshing = true;
      fetch(`${API}/auth/refresh`, { method: "POST", credentials: "include" })
        .then((res) => {
          if (res.ok) socket.connect();
        })
        .catch(() => {})
        .finally(() => {
          refreshing = false;
        });
    });
    return () => {
      socket.disconnect();
    };
  }, [view]);

  const autosize = useCallback(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 168)}px`;
  }, []);

  const post = useCallback(
    async (content: string) => {
      if (!content || thinking || !conversationId) return;
      setDraft("");
      setThinking(true);
      setError(null);
      const clientMessageId = crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        { id: clientMessageId, speaker: "you", text: content },
      ]);
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(`${API}/message`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId, content, clientMessageId }),
        });
        if (res.status === 401) {
          router.replace("/login");
          setThinking(false);
          return;
        }
        if (res.ok) {
          await refreshThread();
          setThinking(false);
          return;
        }
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        if (attempt === 0 && res.status >= 500) continue; // retry same idempotency key
        setError(body?.error?.message ?? "Request failed");
        setThinking(false);
        return;
      }
      setThinking(false);
    },
    [thinking, conversationId, refreshThread, router],
  );

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || thinking) return;
    setListening(false);
    post(text);
  }, [draft, thinking, post]);

  const connectGmail = useCallback(async () => {
    setError(null);
    const res = await fetch(`${API}/integrations/gmail/connect`, { method: "POST", credentials: "include" });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message ?? "Couldn't start Gmail connect — try again");
      return;
    }
    const { sessionToken, authorizationUrl, alreadyConnected } = (await res.json()) as {
      sessionToken?: string;
      authorizationUrl?: string;
      alreadyConnected?: boolean;
    };
    if (alreadyConnected) {
      refreshGmailStatus();
      return;
    }
    // Composio hands back a redirect URL; Nango a session token for its in-page widget.
    if (authorizationUrl) {
      window.location.href = authorizationUrl;
      return;
    }
    if (!sessionToken) {
      setError("Couldn't start Gmail connect — retry later");
      return;
    }
    const { default: Nango } = await import("@nangohq/frontend");
    new Nango({ connectSessionToken: sessionToken }).openConnectUI({
      onEvent: (event) => {
        if (event.type === "connect") {
          refreshGmailStatus();
          return;
        }
        if (event.type === "error") {
          // A user cancel (closed the window, denied consent at the provider) is
          // surfaced by Nango as an error with a raw provider payload. It's not a
          // failure — ignore it instead of flashing `{"error":"access_denied"}`.
          const cancelled =
            event.payload.errorType === "window_closed" ||
            /access_denied/i.test(event.payload.errorMessage);
          if (!cancelled) setError("Gmail connect didn't complete — try again");
        }
      },
    });
  }, [refreshGmailStatus]);

  const disconnectGmail = useCallback(async () => {
    setError(null);
    const res = await fetch(`${API}/integrations/gmail/disconnect`, { method: "POST", credentials: "include" });
    if (!res.ok) {
      setError("Couldn't disconnect Gmail — try again");
      return;
    }
    setGmailConnected(false);
    void refreshGmailStatus();
  }, [refreshGmailStatus]);

  const logout = useCallback(async () => {
    await fetch(`${API}/auth/logout`, { method: "POST", credentials: "include" });
    setMessages([]);
    setConnectorsOpen(false);
    router.replace("/login");
  }, [router]);

  const connectors = [{ name: "Gmail", icon: GmailIcon, connected: gmailConnected }];
  const watching = connectors.filter((c) => c.connected).map((c) => c.name);

  if (view === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <SignalDot />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <SiteHeader
        watching={watching}
        onOpenConnectors={() => setConnectorsOpen(true)}
        onLogout={logout}
      />

      <ConnectorsPanel
        open={connectorsOpen}
        onClose={() => setConnectorsOpen(false)}
        items={connectors}
        onConnect={connectGmail}
        onDisconnect={disconnectGmail}
        onLogout={logout}
      />

      <main className="relative flex-1 overflow-y-auto">
        <div className="pointer-events-none absolute inset-0 grid-texture opacity-40" aria-hidden />

        {isEmpty ? (
          <FirstVisit />
        ) : (
          <div className="relative mx-auto w-full max-w-2xl px-5 pb-16 pt-14">
            <h1 className="sr-only">Your thread with Mimir</h1>
            <ThreadBubbles
              messages={gmailConnected ? messages.map((m) => (m.connectable ? { ...m, connectable: false } : m)) : messages}
              streamingId={streamingId}
              onStreamDone={() => {
                if (streamingId) lastStreamedRef.current = streamingId;
                setStreamingId(null);
              }}
              onAction={(id, action) => post(action)}
              onConnect={connectGmail}
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
            {error ? <p className="pt-2 text-xs text-destructive">{error}</p> : null}
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
              onClick={() => setListening((value) => !value)}
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
              ? "Listening — speak, it keeps working in the background."
              : "Always listening. Hand it your apps, it connects the dots."}
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
      </Reveal>
    </div>
  );
}
