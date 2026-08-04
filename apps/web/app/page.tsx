"use client";

import Image from "next/image";
import Link from "next/link";
import { motion } from "motion/react";
import { Stagger, Item } from "@/components/landing/motion";
import { Spotlight } from "@/components/landing/Spotlight";
import { MovingBorderLink } from "@/components/landing/MovingBorder";
import { Marquee } from "@/components/landing/Marquee";
import { FlowBeams } from "@/components/landing/FlowBeams";
import { ThreadDemo } from "@/components/landing/ThreadDemo";
import { GlowCard } from "@/components/landing/GlowCard";

import {
  GmailIcon,
  GoogleCalendarIcon,
  NotionIcon,
  LinearIcon,
  GitHubIcon,
  SlackIcon,
} from "@/components/landing/brand-icons";

const integrations = [
  { name: "Gmail", icon: GmailIcon },
  { name: "Calendar", icon: GoogleCalendarIcon },
  { name: "Notion", icon: NotionIcon },
  { name: "Linear", icon: LinearIcon },
  { name: "GitHub", icon: GitHubIcon },
  { name: "Slack", icon: SlackIcon },
];

const vignettes = [
  {
    outcome: "One ping instead of two, for the same problem.",
    body: "You mentioned a PR needed review. Mimir noticed it was still open two days later, saw the related Linear ticket had started blocking someone else's sprint, and surfaced both together.",
    span: "sm:col-span-2 sm:row-span-2",
    size: "large" as const,
  },
  {
    outcome: "The answer was already written down.",
    body: "A Slack thread went quiet on something you were waiting on. Mimir checked the linked Notion doc, saw it had been updated an hour earlier, and told you. You didn't have to ask again.",
    span: "sm:col-span-2",
    size: "small" as const,
  },
  {
    outcome: "Two replies, one summary.",
    body: "Two people answered the same email thread while you were in back-to-back meetings. Mimir held both, merged the context, and gave you one update instead of two interruptions.",
    span: "sm:col-span-1",
    size: "small" as const,
  },
  {
    outcome: "It closed the loop before you opened a tab.",
    body: "You said to keep an eye on the migration ticket. When the GitHub PR tied to it was approved, Mimir told you it was ready to ship.",
    span: "sm:col-span-1",
    size: "small" as const,
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main>
        <Hero />
        <IntegrationRow />
        <HowItWorks />
        <Behaviours />
        <Continuity />
        <Trust />
        <Closing />
      </main>
      <Footer />
    </div>
  );
}

function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-6 px-6 py-4">
        <Link href="/" className="flex items-center gap-2.5">
          <Image
            src="/logo.png"
            alt="Mimir"
            width={28}
            height={28}
            className="size-7 -translate-y-1 rounded-full object-contain"
          />
          <span className="font-condensed text-lg font-semibold text-foreground">Mimir</span>
        </Link>
        <nav className="flex shrink-0 items-center gap-6 text-sm text-muted-foreground">
          <Link
            href="#how"
            className="hidden transition-colors duration-200 hover:text-foreground sm:inline"
          >
            How it works
          </Link>
          <Link
            href="/login"
            className="rounded-md border border-border-strong px-3.5 py-1.5 text-foreground transition-colors duration-200 hover:bg-secondary"
          >
            Log in
          </Link>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-border">
      <Spotlight className="inset-x-0 -top-40 h-[36rem]" />
      <Spotlight
        className="top-10 right-[-10%] h-[28rem] w-[28rem]"
        size="50% 50% at 50% 50%"
        strength={7}
        duration={30}
      />
      <div className="relative mx-auto max-w-5xl px-6 pt-28 pb-24 sm:pt-40 sm:pb-32">
        <p className="reveal text-sm text-muted-foreground">
          The assistant that never stops listening
        </p>
        <h1
          className="reveal font-condensed mt-7 max-w-5xl text-[2.75rem] leading-[1.02] font-semibold sm:text-6xl md:text-7xl"
          style={{ animationDelay: "80ms" }}
        >
          You say it once.
          <br />
          Mimir keeps working on it.
        </h1>
        <p
          className="reveal mt-8 max-w-xl text-lg leading-relaxed text-muted-foreground"
          style={{ animationDelay: "160ms" }}
        >
          Not a chat window you open and close. An assistant that keeps the full context of your
          work, never stops listening, and handles the tools you already live in, speaking up only
          when something actually matters.
        </p>
        <div
          className="reveal mt-10 flex items-center gap-5"
          style={{ animationDelay: "240ms" }}
        >
          <MovingBorderLink href="/login">Log in</MovingBorderLink>
          <span className="text-sm text-muted-foreground">Handles your apps for you</span>
        </div>
      </div>
    </section>
  );
}

function IntegrationRow() {
  return (
    <section className="border-b border-border">
      <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-10 sm:flex-row sm:items-center sm:gap-8">
        <span className="shrink-0 text-xs tracking-widest text-muted-foreground uppercase">
          Already where you work
        </span>
        <Marquee className="min-w-0 flex-1" duration={38}>
          {integrations.map((integration) => (
            <span
              key={integration.name}
              className="flex items-center gap-2 pr-8 text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground"
            >
              <integration.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {integration.name}
            </span>
          ))}
        </Marquee>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how" className="border-b border-border">
      <div className="mx-auto max-w-5xl px-6 py-24 sm:py-32">
        <Stagger className="max-w-2xl" gap={0.1}>
          <Item as="h2" className="font-condensed text-3xl leading-tight font-semibold sm:text-5xl">
            What it actually does
          </Item>
          <Item as="p" className="mt-6 text-lg leading-relaxed text-muted-foreground">
            You tell Mimir something: a task, something you're waiting on, someone you're expecting
            to hear back from. It holds it, watches the tools it's connected to, and decides what's
            worth your attention.
          </Item>
        </Stagger>

        <Stagger className="mt-16" amount={0.2}>
          <Item variant="scale">
            <FlowBeams marks={integrations} />
          </Item>
        </Stagger>

        <Stagger
          className="mt-16 grid auto-rows-[minmax(0,auto)] gap-4 sm:grid-cols-4"
          gap={0.1}
          amount={0.12}
        >
          {vignettes.map((vignette) => (
            <GlowCard key={vignette.outcome} className={vignette.span}>
              <p
                className={
                  "font-condensed font-semibold " +
                  (vignette.size === "large"
                    ? "text-2xl leading-snug sm:text-3xl"
                    : "text-xl leading-snug")
                }
              >
                {vignette.outcome}
              </p>
              <p className="mt-4 leading-relaxed text-muted-foreground">{vignette.body}</p>
              {vignette.size === "large" ? (
                <p className="mt-auto border-t border-border pt-5 text-xs tracking-widest text-muted-foreground uppercase">
                  correlated across GitHub and Linear
                </p>
              ) : null}
            </GlowCard>
          ))}
        </Stagger>
      </div>
    </section>
  );
}

const behaviours = [
  {
    title: "It holds all the context",
    body: "Mention a task, a thing you're waiting on, a person you expect to hear back from. Mimir keeps it all in mind, across every tool, so you never re-ask.",
  },
  {
    title: "It never stops listening",
    body: "Tell it once and it keeps working in the background, watching your tools and updating you as things move, even after you've closed the tab.",
  },
  {
    title: "It filters before it interrupts",
    body: "It watches your tools quietly and discards the noise. A reply worth knowing about, a deadline closing in, a PR that needs eyes: those reach you. Nothing else does.",
  },
  {
    title: "It asks when it isn't sure",
    body: "If two things you mentioned turn out to be the same thing, it checks with you first. It would rather confirm than guess on your behalf.",
  },
];

function Behaviours() {
  return (
    <section className="border-b border-border">
      <div className="mx-auto max-w-5xl px-6 py-24 sm:py-32">
        <Stagger
          className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2"
          gap={0.09}
          amount={0.12}
        >
          {behaviours.map((item, index) => (
            <Item key={item.title} variant="scale" className="bg-background p-8 sm:p-10">
              <span className="font-condensed text-sm text-signal">0{index + 1}</span>
              <h3 className="font-condensed mt-5 text-2xl leading-snug font-semibold">
                {item.title}
              </h3>
              <p className="mt-4 leading-relaxed text-muted-foreground">{item.body}</p>
            </Item>
          ))}
        </Stagger>
      </div>
    </section>
  );
}

function Continuity() {
  return (
    <section className="relative overflow-hidden border-b border-border">
      <Spotlight
        className="inset-0"
        size="50% 60% at 80% 20%"
        strength={8}
        duration={26}
      />
      <div className="relative mx-auto max-w-5xl px-6 py-24 sm:py-32">
        <Stagger className="max-w-2xl" gap={0.11}>
          <Item as="h2" className="font-condensed text-3xl leading-tight font-semibold sm:text-5xl">
            Everything you need, in one running context
          </Item>
          <Item as="p" className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
            Tell it once and it keeps working in the background. Every app you use feeds one
            running thread. Nothing gets re-explained, nothing gets handed back to you as a to-do
            list.
          </Item>
        </Stagger>
        <div className="mt-12">
          <ThreadDemo />
        </div>
      </div>
    </section>
  );
}

function Trust() {
  return (
    <section className="relative overflow-hidden border-b border-border">
      <div className="grid-texture pointer-events-none absolute inset-0 opacity-60" aria-hidden="true" />
      {[
        { top: "18%", left: "12%", delay: 0 },
        { top: "34%", left: "72%", delay: 1.4 },
        { top: "62%", left: "28%", delay: 2.6 },
        { top: "74%", left: "84%", delay: 0.8 },
        { top: "24%", left: "48%", delay: 3.4 },
      ].map((star) => (
        <motion.span
          key={`${star.top}-${star.left}`}
          aria-hidden="true"
          className="pointer-events-none absolute h-1 w-1 rounded-full bg-signal"
          style={{ top: star.top, left: star.left }}
          animate={{ opacity: [0, 0.9, 0] }}
          transition={{ duration: 5, repeat: Infinity, delay: star.delay, ease: "easeInOut" }}
        />
      ))}
      <div className="relative mx-auto max-w-5xl px-6 py-24 sm:py-32">
        <Stagger className="max-w-2xl" gap={0.1}>
          <Item as="h2" className="font-condensed text-3xl leading-tight font-semibold sm:text-5xl">
            You stay in control of what it sees
          </Item>
          <Item as="p" className="mt-6 text-lg leading-relaxed text-muted-foreground">
            Connect one tool or all six. Revoke any of them at any time. Mimir tells you what it
            acted on and why, and it never takes an irreversible step without asking.
          </Item>
        </Stagger>
        <Stagger className="mt-12 grid gap-4 sm:grid-cols-3" gap={0.1} amount={0.15}>
          {[
            ["Per-tool access", "Grant and revoke each connection on its own."],
            ["Nothing silent", "Every action it takes is written back into your conversation."],
            ["Asks before it acts", "Irreversible steps wait for a yes from you."],
          ].map(([title, body]) => (
            <Item
              key={title}
              variant="scale"
              className="rounded-lg border border-border bg-card/40 p-6 backdrop-blur-sm"
            >
              <h3 className="font-condensed text-lg font-semibold">{title}</h3>
              <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
            </Item>
          ))}
        </Stagger>
      </div>
    </section>
  );
}

function Closing() {
  return (
    <section id="request" className="relative overflow-hidden border-b border-border">
      <Spotlight className="inset-x-0 bottom-[-30%] h-[26rem]" strength={9} duration={28} />
      <div className="relative mx-auto max-w-5xl px-6 py-28 sm:py-36">
        <Stagger className="max-w-2xl" gap={0.11}>
          <Item as="h2" className="font-condensed text-4xl leading-[1.05] font-semibold sm:text-6xl">
            You say it once.
            <br />
            Mimir handles the rest.
          </Item>
          <Item as="p" className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
            Log in and let it run the apps you already use.
          </Item>
          <Item className="mt-10">
            <MovingBorderLink href="/login">Log in</MovingBorderLink>
          </Item>
        </Stagger>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="mx-auto flex max-w-5xl items-center justify-center gap-4 px-6 py-10 text-sm text-muted-foreground">
      <span>© {new Date().getFullYear()} Mimir</span>
    </footer>
  );
}
