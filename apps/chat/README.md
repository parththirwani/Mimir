# Mimir Thread

Build a chat page for Mimir at /chat. This must use the exact same design system already defined in this codebase's src/styles.css — do not introduce new colors, fonts, radii, or spacing scales. Reuse existing utilities and components (Spotlight, GlowCard, MovingBorderButton, the .reveal utility, .grid-texture) wherever they fit. This should feel like the same product as the landing page, mid-conversation — not a separate "app."

═══════════════════════════════════

DESIGN SYSTEM — REUSE EXACTLY, DO NOT REINVENT

═══════════════════════════════════

Colors (already defined as CSS variables, reference via Tailwind classes bg-background, text-foreground, etc. — never hardcode hex):

- --background: near-black, oklch(0.145 0.004 285)

- --foreground: near-white, oklch(0.965 0.003 90)

- --card: oklch(0.175 0.004 285) — slightly lighter than background, for surfaces

- --secondary / --muted / --accent: oklch(0.23 0.003 285) — mid-dark grey fills

- --muted-foreground: oklch(0.66 0.005 285) — secondary text

- --signal: oklch(0.79 0.13 78) — the ONE warm amber accent. Used for: focus rings, the "still watching" status dot, active/streaming indicator, send-button glow. Never introduce a second accent color.

- --border: oklch(1 0 0 / 8%), --border-strong: oklch(1 0 0 / 16%) — hairline dividers, not solid greys

Typography: font-condensed (Archivo, tight tracking, -0.03em) for the page's small heading/status labels only. font-sans (DM Sans) for all message content and body text — this is a chat interface, message text should be highly legible DM Sans at comfortable line-height, not condensed.

Radius: 0.375rem base (--radius), matching every other surface on the site — small, not pill-shaped.

Borders: hairline (border-border) between message groups, never card shadows.

═══════════════════════════════════

CORE INTERACTION MODEL — NOT A GENERIC CHATBOT UI

═══════════════════════════════════

This is critical: Mimir has no "new chat" button and no conversation list/sidebar. There is exactly one continuous thread per user, matching the landing page's core promise ("You say it once"). Do not build a ChatGPT-style sidebar of past conversations — that would directly contradict the product's positioning. The page is just: the thread, and the composer. If a sidebar is needed at all, it should only ever show connected integrations (Gmail, Calendar, Notion, Linear, GitHub, Slack) with their status — never a list of chats.

═══════════════════════════════════

PAGE STRUCTURE

═══════════════════════════════════

1. NAV (identical to landing page)

Reuse the exact same sticky header: the Mimir mark (small circle-in-circle icon + "Mimir" in font-condensed semibold), border-b border-border, bg-background/80 backdrop-blur-md. Right side: instead of "Request access," show a small muted-foreground status line, e.g. a pulsing signal-colored dot + "Watching Gmail, Linear, GitHub" (or whichever integrations are connected) — quiet, not a prominent feature.

2. THREAD (main scroll area)

- Full-height scrollable column, max-w-2xl or max-w-3xl centered (narrower than the landing page's max-w-5xl — a chat reads better in a tighter column), generous vertical padding.

- Follow the exact message pattern already established in ThreadDemo.tsx: each message is a flex row with a fixed-width uppercase tracking-widest text-xs text-muted-foreground label ("YOU" / "MIMIR") on the left, and message text on the right — NOT rounded chat bubbles, NOT avatars, NOT left/right alignment splitting. This label-based layout is the established Mimir visual language and must carry over exactly.

- User messages: text-foreground. Mimir's messages: text-muted-foreground (slightly recessed, consistent with the landing page's convention that Mimir's voice is quiet, not shouting for attention) — EXCEPT the most recent Mimir message in an active/streaming state, which should be text-foreground while it's actively arriving, then settle to text-muted-foreground once older.

- Hairline divider (divide-y divide-border) between message groups, same as ThreadDemo.

- Every new message reveals with the same motion signature already defined: opacity 0→1, translateY(10-16px)→0, 500-560ms, cubic-bezier(0.16, 1, 0.3, 1) — this is the existing .reveal utility and Stagger/Item pattern from src/components/motion.tsx; reuse it directly rather than writing new transition logic.

- Mimir's replies should stream in with a typewriter/text-generate effect, reusing the existing TextGenerate component pattern from motion.tsx (word-by-word reveal), not an instant paste-in.

- Proactive messages (things Mimir surfaces unprompted, not in response to a user message) should be visually distinguished subtly — e.g. preceded by a small timestamp/date divider ("3 days later" style, matching the landing page's proof-section vignettes) so it's clear this arrived on its own, not as a reply.

3. LIVE STATUS LINE (reuse ThreadDemo's pattern exactly)

Below the last message, when idle, show the exact same status indicator already built for the landing page demo: a small pulsing signal-colored dot (animate opacity 0.3→1→0.3, 2.4s, infinite) + muted-foreground text like "Still watching — nothing else worth telling you yet." This is the single most important piece of brand continuity between the landing page and the real product — it must look identical.

4. COMPOSER (bottom, sticky)

- Sticky to the bottom of the viewport, bg-background/90 backdrop-blur-md, border-t border-border, matching the nav's blur treatment for visual symmetry top and bottom.

- A single-line-growing-to-multiline textarea, bg-transparent, border border-input, rounded-md (--radius), text-foreground, placeholder text-muted-foreground, focus:border-signal (no glow ring beyond the border color shift — stay restrained).

- Placeholder copy in the same voice as the rest of the site: something like "Tell it something once." — not "Type a message..."

- A voice-input toggle (mic icon) sitting inline at the left or right of the textarea, ghost/icon-button style, switching to a small animated waveform in signal color when actively listening. Keep this understated — same rule as the brand prompt: voice is one mode of the same thread, never a separate flashy feature.

- Send button: reuse the existing MovingBorderButton component exactly as used in the landing page's closing CTA — same slow rotating conic-gradient hairline in the signal color. This ties the chat's primary action visually back to the landing page's primary CTA.

- Disable/idle state while Mimir is "thinking": show the same signal-colored pulsing dot pattern inline near the composer rather than a generic spinner.

5. EMPTY / FIRST-VISIT STATE

Since there's no "new chat," the very first time a user lands on /chat with no messages yet, show a centered, quiet prompt reusing the Spotlight component (same soft radial glow used behind the landing page hero) behind a single line of font-condensed text: something like "Say the first thing." with muted-foreground supporting copy below it: "There's nothing to set up. Just tell it what you're waiting on." This should feel like the hero section's DNA, not a cold blank chat window.

═══════════════════════════════════

WHAT TO AVOID

═══════════════════════════════════

- No conversation sidebar/history list, no "new chat" button — this breaks the core product promise.

- No rounded chat bubbles, no avatars, no left/right message alignment split — stick to the label-based layout already established.

- No new accent colors, no gradients beyond what's already defined (Spotlight, moving-border conic gradient) — everything stays greyscale + the one signal amber.

- No generic spinner/loading UI — reuse the pulsing signal dot pattern already built for "still watching."

- No isolated "Voice Mode" screen or modal — voice is a toggle within the same composer, same thread.

Build this so that landing on /chat feels like scrolling directly out of the Continuity section of the landing page into the real product — same fonts, same motion timing, same restraint, same single thread.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/9115174e-7ed2-483e-ba0b-15c9790cfab6).

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
