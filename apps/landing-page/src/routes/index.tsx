import { createFileRoute } from "@tanstack/react-router";
import { motion } from "motion/react";
import { Stagger, Item, TextGenerate } from "@/components/motion";
import { Spotlight } from "@/components/Spotlight";
import { MovingBorderLink, MovingBorderButton } from "@/components/MovingBorder";
import { Marquee } from "@/components/Marquee";
import { FlowBeams } from "@/components/FlowBeams";
import { ThreadDemo } from "@/components/ThreadDemo";
import { GlowCard } from "@/components/GlowCard";
import { Compare } from "@/components/Compare";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Mimir — the assistant that keeps working after you stop asking" },
      {
        name: "description",
        content:
          "Mimir is one continuous AI assistant. Tell it something once; it watches your Gmail, Calendar, Notion, Linear, GitHub and Slack and only interrupts when it matters.",
      },
      { property: "og:title", content: "Mimir — the assistant that keeps working after you stop asking" },
      {
        property: "og:description",
        content:
          "Mimir is one continuous AI assistant. Tell it something once; it watches your Gmail, Calendar, Notion, Linear, GitHub and Slack and only interrupts when it matters.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Home,
});

const integrations = [
  { name: "Gmail", path: "M2 5.5h20v13H2zM2 5.5 12 13l10-7.5" },
  { name: "Calendar", path: "M3.5 5.5h17v15h-17zM3.5 10h17M8 3v4M16 3v4" },
  { name: "Notion", path: "M4.5 4.5h15v15h-15zM8 16V8l8 8V8" },
  { name: "Linear", path: "M4 14 10 20M4 9.5 14.5 20M4.5 5.5 18.5 19.5M9 4l11 11M14.5 3.5 20.5 9.5" },
  {
    name: "GitHub",
    path: "M12 3a8.5 8.5 0 0 0-2.7 16.6c0-1 0-2.2 0-2.8-2.4.4-3-1.2-3-1.2-.4-1-1-1.3-1-1.3-.9-.6 0-.6 0-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.7.4-1.1.6-1.4-2-.3-3.6-1.2-3.6-4a3.6 3.6 0 0 1 .9-2.4c-.1-.3-.4-1.2.1-2.5 0 0 .9-.3 3 1a7.6 7.6 0 0 1 4 0c2.1-1.3 3-1 3-1 .5 1.3.2 2.2.1 2.5a3.6 3.6 0 0 1 .9 2.4c0 2.8-1.6 3.7-3.6 4 .3.4.6 1 .6 2v3A8.5 8.5 0 0 0 12 3Z",
  },
  { name: "Slack", path: "M6 9h12M6 15h12M9 6v12M15 6v12" },
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
    body: "A Slack thread went quiet on something you were waiting on. Mimir checked the linked Notion doc, saw it had been updated an hour earlier, and told you — you didn't have to ask again.",
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

const notes = [
  "It waited three days on a contract reply so I didn't have to remember to.",
  "First assistant that didn't hand my own to-do list back to me.",
  "It asked before merging two things it thought were the same. That's the whole trick.",
  "I stopped checking Linear at night. It tells me if something actually broke.",
  "Quiet for two days, then exactly the one thing I needed.",
];

function Home() {
  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main>
        <Hero />
        <IntegrationRow />
        <Problem />
        <HowItWorks />
        <Behaviours />
        <Continuity />
        <Trust />
        <Notes />
        <Closing />
      </main>
      <Footer />
    </div>
  );
}

function Mark({ className }: { className?: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <svg viewBox="0 0 24 24" className={"h-4 w-4 " + (className ?? "")} aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="1.25" />
        <circle cx="12" cy="12" r="3" fill="currentColor" />
      </svg>
      <span className="font-condensed text-[1.0625rem] font-semibold tracking-tight">Mimir</span>
    </span>
  );
}

function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="mx-auto grid max-w-5xl grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-6 py-4 sm:flex sm:justify-between">
        <Mark />
        <nav className="flex shrink-0 items-center gap-6 text-sm text-muted-foreground">
          <a
            href="#how"
            className="hidden transition-colors duration-200 hover:text-foreground sm:inline"
          >
            How it works
          </a>
          <a
            href="#request"
            className="rounded-md border border-border-strong px-3.5 py-1.5 text-foreground transition-colors duration-200 hover:bg-secondary"
          >
            Request access
          </a>
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
        <Stagger className="max-w-3xl" gap={0.11}>
          <Item className="text-sm text-muted-foreground" as="p">
            <span className="text-signal">—</span> An assistant that stays running
          </Item>
        </Stagger>
        <h1 className="font-condensed mt-7 max-w-3xl text-[2.75rem] leading-[1.02] font-semibold sm:text-6xl md:text-7xl">
          <TextGenerate text="You say it once." />
          <br />
          <TextGenerate text="Mimir keeps working on it." delay={0.5} />
        </h1>
        <Stagger className="max-w-xl" gap={0.11} delay={0.9}>
          <Item className="mt-8 text-lg leading-relaxed text-muted-foreground" as="p">
            Not a chat window you open and close. One continuous assistant that watches the tools you
            already work in, and speaks up only when something actually matters.
          </Item>
          <Item className="mt-10 flex items-center gap-5">
            <MovingBorderLink href="#request">Request access</MovingBorderLink>
            <span className="text-sm text-muted-foreground">Private beta</span>
          </Item>
        </Stagger>
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
              <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                <path
                  d={integration.path}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.25"
                  strokeLinejoin="round"
                />
              </svg>
              {integration.name}
            </span>
          ))}
        </Marquee>
      </div>
    </section>
  );
}

function Problem() {
  return (
    <section className="border-b border-border">
      <div className="mx-auto max-w-5xl px-6 py-24 sm:py-32">
        <Stagger className="max-w-2xl" gap={0.1}>
          <Item as="h2" className="font-condensed text-3xl leading-tight font-semibold sm:text-5xl">
            The work isn't scattered. Knowing about it is.
          </Item>
          <Item as="p" className="mt-6 text-lg leading-relaxed text-muted-foreground">
            Six tools, all talking at once, none of them talking to each other. Drag across to see
            the difference.
          </Item>
        </Stagger>
        <Stagger className="mt-12" amount={0.15}>
          <Item variant="scale">
            <Compare />
          </Item>
        </Stagger>
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
            You tell Mimir something — a task, something you're waiting on, someone you're expecting
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
                  <span className="text-signal">—</span> correlated across GitHub and Linear
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
    title: "It remembers so you don't repeat yourself",
    body: "Mention a task, a thing you're waiting on, a person you expect to hear back from. Mimir holds it and keeps checking. You never re-ask.",
  },
  {
    title: "It filters before it interrupts",
    body: "It watches your tools quietly and discards the noise. A reply worth knowing about, a deadline closing in, a PR that needs eyes — those reach you. Nothing else does.",
  },
  {
    title: "It asks when it isn't sure",
    body: "If two things you mentioned turn out to be the same thing, it checks with you first. It would rather confirm than guess on your behalf.",
  },
  {
    title: "It finds you where you already are",
    body: "Desktop, browser, a push notification, or a quiet email if you've stepped away. Type to it or say it out loud — same thread either way.",
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
            One thread, never restarted
          </Item>
          <Item as="p" className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
            Typed or spoken, it's the same conversation. Nothing gets re-explained, and nothing gets
            handed back to you as a to-do list.
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
            ["Nothing silent", "Every action it takes is written back into your thread."],
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

function Notes() {
  return (
    <section className="border-b border-border py-16">
      <div className="mx-auto max-w-5xl px-6">
        <Stagger gap={0.1}>
          <Item as="p" className="text-xs tracking-widest text-muted-foreground uppercase">
            From the beta
          </Item>
        </Stagger>
      </div>
      <Marquee className="mt-8" duration={64}>
        {notes.map((note) => (
          <figure
            key={note}
            className="mr-4 w-[19rem] shrink-0 rounded-lg border border-border bg-card/40 p-6 transition-colors duration-300 hover:border-border-strong"
          >
            <blockquote className="text-sm leading-relaxed text-muted-foreground">{note}</blockquote>
          </figure>
        ))}
      </Marquee>
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
            Stop managing your assistant.
          </Item>
          <Item as="p" className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
            Mimir is in private beta. We're adding a small number of people at a time so it stays
            useful.
          </Item>
          <Item className="mt-10">
            <form
              className="flex w-full max-w-md flex-col gap-3 sm:flex-row"
              onSubmit={(event) => event.preventDefault()}
            >
              <label className="sr-only" htmlFor="email">
                Email address
              </label>
              <input
                id="email"
                type="email"
                required
                placeholder="you@company.com"
                className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-signal focus:outline-none"
              />
              <MovingBorderButton className="shrink-0">Request access</MovingBorderButton>
            </form>
          </Item>
        </Stagger>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="mx-auto grid max-w-5xl grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-6 py-10 text-sm text-muted-foreground sm:flex sm:justify-between">
      <Mark className="text-muted-foreground" />
      <span className="shrink-0">© {new Date().getFullYear()} Mimir</span>
    </footer>
  );
}
