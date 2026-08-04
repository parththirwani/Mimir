import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteHeader } from "@/components/site-header";
import { Spotlight } from "@/components/spotlight";
import { GlowCard } from "@/components/glow-card";
import { MovingBorderButton } from "@/components/moving-border-button";
import { Reveal, Stagger, Item } from "@/components/motion";
import { ThreadDemo } from "@/components/thread-demo";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Mimir — You say it once" },
      {
        name: "description",
        content:
          "Mimir keeps watching your inbox, calendar and issues after you've told it once, and speaks up only when something actually moves.",
      },
      { property: "og:title", content: "Mimir — You say it once" },
      {
        property: "og:description",
        content: "Tell it what you're waiting on once. It watches, and tells you when it moves.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

const CONTINUITY = [
  {
    title: "One thread",
    body: "No folders, no new chats, no starting over. Everything you've ever told it stays in one place.",
  },
  {
    title: "It keeps watching",
    body: "Gmail, Calendar, Notion, Linear, GitHub, Slack. You don't check in — it comes to you.",
  },
  {
    title: "Quiet by default",
    body: "It only speaks when something has actually changed. Silence means nothing worth telling you.",
  },
];

function Landing() {
  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />

      <section className="relative overflow-hidden border-b border-border">
        <Spotlight />
        <div className="pointer-events-none absolute inset-0 grid-texture opacity-50" aria-hidden />
        <div className="relative mx-auto max-w-5xl px-5 py-28 text-center">
          <Reveal>
            <span className="label-eyebrow">Standing memory</span>
            <h1 className="mx-auto mt-6 max-w-2xl font-condensed text-5xl font-semibold leading-[1.05] text-foreground sm:text-6xl">
              You say it once.
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-base leading-8 text-muted-foreground">
              Tell Mimir what you're waiting on. It watches everything you've connected and speaks
              up the moment it moves — not before.
            </p>
          </Reveal>
          <Reveal delay={120} className="mt-10 flex justify-center">
            <Link to="/chat">
              <MovingBorderButton>Open your thread</MovingBorderButton>
            </Link>
          </Reveal>
        </div>
      </section>

      <section className="border-b border-border">
        <div className="mx-auto max-w-5xl px-5 py-24">
          <Reveal>
            <span className="label-eyebrow">Continuity</span>
            <h2 className="mt-5 max-w-xl font-condensed text-3xl font-semibold text-foreground">
              The conversation never restarts.
            </h2>
          </Reveal>
          <Stagger className="mt-12 grid gap-4 md:grid-cols-3">
            {CONTINUITY.map((item, index) => (
              <Item key={item.title} index={index}>
                <GlowCard className="h-full">
                  <h3 className="font-condensed text-lg font-semibold text-foreground">
                    {item.title}
                  </h3>
                  <p className="mt-3 text-sm leading-7 text-muted-foreground">{item.body}</p>
                </GlowCard>
              </Item>
            ))}
          </Stagger>

          <Reveal delay={140} className="mx-auto mt-14 max-w-2xl">
            <ThreadDemo />
          </Reveal>
        </div>
      </section>

      <section className="relative overflow-hidden">
        <Spotlight className="opacity-60" />
        <div className="relative mx-auto max-w-5xl px-5 py-24 text-center">
          <Reveal>
            <h2 className="mx-auto max-w-lg font-condensed text-3xl font-semibold text-foreground sm:text-4xl">
              Stop repeating yourself.
            </h2>
            <div className="mt-8 flex justify-center">
              <Link to="/chat">
                <MovingBorderButton>Say the first thing</MovingBorderButton>
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-8 text-xs text-muted-foreground">
          <span>Mimir</span>
          <span>Standing memory, not another inbox.</span>
        </div>
      </footer>
    </div>
  );
}
