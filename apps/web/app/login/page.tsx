"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MimirMark } from "@/components/chat/mimir-mark";
import { Spotlight } from "@/components/chat/spotlight";
import { MovingBorderButton } from "@/components/chat/moving-border-button";

const API = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000/api/v1";

type Mode = "login" | "register";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`${API}/auth/${mode}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: { message?: string } };
        setError(data.error?.message ?? "Auth failed");
        return;
      }
      router.push("/chat");
    } catch {
      setError("Couldn't reach the server — try again");
    } finally {
      setSubmitting(false);
    }
  };

  const googleUrl = `${API}/auth/google`;

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background px-4">
      <Spotlight />
      <div className="relative w-full max-w-sm rounded-lg border border-border bg-card/40 p-8 backdrop-blur-sm">
        <div className="flex items-center gap-2.5">
          <MimirMark />
          <span className="font-condensed text-lg font-semibold text-foreground">Mimir</span>
        </div>
        <h1 className="font-condensed mt-6 text-2xl font-semibold text-foreground">
          {mode === "login" ? "Welcome back" : "Create an account"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {mode === "login"
            ? "Log in to keep the one thread going."
            : "Start the one thread that never restarts."}
        </p>
        <form className="mt-8 flex flex-col gap-4" onSubmit={submit}>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              className="rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-signal focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">Password</span>
            <input
              type="password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              className="rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-signal focus:outline-none"
            />
          </label>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <MovingBorderButton type="submit" className="w-full" disabled={submitting}>
            {mode === "login" ? "Log in" : "Register"}
          </MovingBorderButton>
        </form>
        <div className="mt-4 flex flex-col items-center gap-3">
          <a
            href={googleUrl}
            className="flex w-full items-center justify-center rounded-md border border-border-strong px-3.5 py-1.5 text-sm text-foreground transition-colors hover:bg-secondary"
          >
            Continue with Google
          </a>
          <button
            type="button"
            onClick={() => setMode(mode === "login" ? "register" : "login")}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {mode === "login" ? "Need an account? Register" : "Have an account? Log in"}
          </button>
        </div>
      </div>
    </div>
  );
}
