# Mimir Assistant

Design the visual and brand identity for Mimir, an always-on AI assistant. Take direct inspiration from Linear, t3.dev, and emergent.sh — restrained, confident, engineer-built-this-not-marketing-built-this energy. This should feel like a YC-caliber startup site, not a generic SaaS template.

WHAT MIMIR ACTUALLY DOES (explain this on the page, plainly, no jargon)

Mimir is one continuous assistant, not a chat app you open and close. You tell it something once — a task, something you're waiting on, someone you're expecting to hear back from — and it keeps working on it in the background without needing to be re-asked. It's connected to the tools you already work in — Gmail, Calendar, Notion, Linear, GitHub, Slack — and watches them quietly, filtering out anything unimportant, only interrupting you when something actually matters: a reply worth knowing about, a deadline coming up, a PR that needs a look, a message you don't want to miss. If two things you mentioned turn out to be the same thing, it checks with you before acting rather than guessing. It reaches you wherever you are — desktop, browser, push notification, or a quiet email if you've stepped away. You can type to it or just talk to it out loud — same thread either way, nothing gets re-explained.

Mention the integrations by name once, in passing, as evidence of "it's already where you work" — not as a logo wall or feature list. A small, quiet row of integration marks (Gmail, Calendar, Notion, Linear, GitHub, Slack) can appear once, near this explanation or just below the hero, styled as understated monochrome marks (not full-color brand logos) so they read as supporting detail, not a marketing centerpiece.

BRAND VOICE

Quiet, competent, dry-witted. Never hypey, never exclamation points, never "revolutionary" or "game-changing." Short sentences. Confidence over persuasion — the copy should read like it doesn't need to convince you, just tell you plainly.

COLOR

Dark-mode-first. Near-black background (#0A0A0B / #0C0C0D). One single accent color used sparingly — either a warm off-white or one muted signal color (amber, indigo, or electric blue). Never more than one accent per screen. Everything else is greyscale.

TYPOGRAPHY

This carries the design. A confident, slightly condensed sans-serif for headlines — large, tight tracking, high contrast weight jump from body text. Clean, highly legible sans for body copy at a comfortable size (don't go small/dense). Type hierarchy should do the persuading, not icons or illustration.

LAYOUT & SPACING

Generous whitespace, nothing dense. Thin 1px low-opacity borders instead of card shadows. Rounded-but-not-bubbly corners (small radius, not pill-shaped). Content in a constrained centered column — avoid full-width sprawling sections.

SCROLL ANIMATIONS

Every section reveals as the user scrolls into view — never all at once on page load. Elements fade in and slide up slightly (12-20px, opacity 0 to 1), duration ~500-600ms, decelerating easing, no bounce or overshoot. Stagger child elements within a section by ~80-120ms so content arrives in reading order. Trigger reveals once per section, don't replay on scroll-up. Background gradients may drift subtly on scroll; text and UI elements never parallax. Section transitions bleed into each other rather than hard-cutting. Respect prefers-reduced-motion with a plain fade fallback.

MOTION (non-scroll)

Soft hover states (slight scale/color shift, no bounce). Motion should feel like content settling into place, never like it's performing.

WHAT TO AVOID

No stock AI/robot imagery, no purple-gradient SaaS clichés, no chat-bubble icons, no dense feature grids, no busy multi-color palettes, no bouncy/playful animation, no scroll-jacking or heavy scroll-triggered video/canvas effects. Never isolate voice into its own hyped-up callout ("Introducing Voice!") — it's one mode of the same conversation, mention it in the same understated register as everything else.

DESIGN REFERENCE

Attached are visual references for tone and craft level only — use them to calibrate spacing, type scale, restraint, and overall polish. Do not copy any specific layout, illustration, icon, or component from them directly. Treat them as a feel to aim for, not a template to replicate.

Build every component and section using these rules consistently — the whole page should feel like one considered decision, not a collection of trendy sections. The stack is next js, tailwind css to design dont use pure css design the landing page

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://mimir-always-on.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/c48baeac-f61b-4d96-a2c6-6eb1c1f18ed7).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
