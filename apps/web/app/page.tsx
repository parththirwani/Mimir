"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

interface ChatMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

const API = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000/api/v1";

type View = "loading" | "login" | "chat";

export default function Home() {
  const [view, setView] = useState<View>("loading");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string>("");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<number>(0);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch(`${API}/conversation`, { credentials: "include" });
      if (res.status === 401) {
        setView("login");
        return;
      }
      const data = (await res.json()) as { conversation: { id: string; messages: ChatMessage[] } };
      setConversationId(data.conversation.id);
      setMessages(data.conversation.messages);
      setView("chat");
    })();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, revealed]);

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  useEffect(() => {
    if (!lastAssistant || revealed >= lastAssistant.content.length) return;
    const t = setTimeout(() => setRevealed((n) => Math.min(n + 2, lastAssistant.content.length)), 10);
    return () => clearTimeout(t);
  }, [lastAssistant, revealed]);

  const submitAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    const route = authMode === "login" ? "login" : "register";
    const res = await fetch(`${API}/auth/${route}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const data = (await res.json()) as { error?: { message?: string } };
      setAuthError(data.error?.message ?? "Auth failed");
      return;
    }
    setView("loading");
    const conv = await fetch(`${API}/conversation`, { credentials: "include" });
    const data = (await conv.json()) as { conversation: { id: string; messages: ChatMessage[] } };
    setConversationId(data.conversation.id);
    setMessages(data.conversation.messages);
    setView("chat");
  };

  const logout = async () => {
  await fetch(`${API}/auth/logout`, { method: "POST", credentials: "include" });
  setView("login");
  setMessages([]);
};

const send = async (e: React.FormEvent) => {
  e.preventDefault();
  const content = input.trim();
    if (!content || sending || !conversationId) return;
    setInput("");
    setSending(true);
    setError(null);
    const clientMessageId = crypto.randomUUID();
    const optimistic: ChatMessage = {
      id: clientMessageId,
      conversationId,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    setMessages((m) => [...m, optimistic]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${API}/message`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, content, clientMessageId }),
      });
      if (res.status === 401) {
        setView("login");
        return;
      }
      if (res.ok) {
        const data = (await res.json()) as { message: ChatMessage };
        setRevealed(0);
        setMessages((m) => [...m, data.message]);
        setSending(false);
        return;
      }
      const body = (await res.json()) as { error?: { message?: string } };
      if (attempt === 0 && res.status >= 500) continue; // retry same idempotency key
      setError(body.error?.message ?? "Request failed");
      setSending(false);
      return;
    }
  };

  if (view === "loading") return <main style={styles.center}><p>Loading…</p></main>;

  if (view === "login") {
    const googleUrl = new URL(`${API}/auth/google`);
    return (
      <main style={styles.center}>
        <form onSubmit={submitAuth} style={styles.card}>
          <h1 style={styles.title}>Mimir</h1>
          {authMode === "login" ? <p>Log in to continue</p> : <p>Create an account</p>}
          <label>Email
            <input style={styles.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label>Password
            <input style={styles.input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {authError && <p style={styles.error}>{authError}</p>}
          <button style={styles.button} type="submit">{authMode === "login" ? "Log in" : "Register"}</button>
          <button style={styles.button} type="button" onClick={() => setAuthMode(authMode === "login" ? "register" : "login")}>
            {authMode === "login" ? "Need an account? Register" : "Have an account? Log in"}
          </button>
          <a style={styles.button} href={googleUrl.toString()}>Continue with Google</a>
        </form>
      </main>
    );
  }

  return (
    <main style={styles.fill}>
      <div style={styles.thread}>
        <header style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
          <button style={{ ...styles.button, fontSize: 12 }} type="button" onClick={logout}>Log out</button>
        </header>
        {messages.map((m, i) => {
          const isLast = i === messages.length - 1 && m.role === "assistant";
          const shown = isLast ? m.content.slice(0, revealed) : m.content;
          return (
            <div key={m.id} style={{ ...styles.bubble, alignSelf: m.role === "user" ? "flex-end" : "flex-start" }}>
              {shown || (m.role === "assistant" && sending ? "…" : "")}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      {error && <p style={styles.error}>{error}</p>}
      <form onSubmit={send} style={styles.composer}>
        <input
          style={{ ...styles.input, flex: 1 }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message…"
          disabled={sending}
        />
        <button style={styles.button} type="submit" disabled={sending || !input.trim()}>Send</button>
      </form>
    </main>
  );
}

const styles: Record<string, CSSProperties> = {
  center: { height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" },
  card: { display: "flex", flexDirection: "column", gap: 12, width: 320 },
  title: { margin: 0 },
  input: { padding: 8, fontSize: 14, borderRadius: 6, border: "1px solid #888" },
  button: { padding: 8, fontSize: 14, borderRadius: 6, border: "1px solid #888", cursor: "pointer" },
  thread: { flex: 1, width: "100%", maxWidth: 640, margin: "0 auto", overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, padding: 16 },
  bubble: { maxWidth: "75%", padding: "8px 12px", borderRadius: 10, background: "rgba(128,128,128,0.18)", whiteSpace: "pre-wrap" },
  composer: { width: "100%", maxWidth: 640, margin: "0 auto", padding: 12, display: "flex", gap: 8 },
  error: { color: "crimson" },
};