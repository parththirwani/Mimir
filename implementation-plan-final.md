# Implementation Plan — Final (Tasks & Subtasks)

This supersedes the earlier phase list and folds in every decision from the production spec. Each task lists subtasks with enough detail (exact values, table/column names, function signatures) that no implementation decision is left open. Work phase by phase, top to bottom — each phase's checkpoint should pass before starting the next.

Stack: Next.js (static export) frontend, Express + socket.io backend, separate BullMQ worker process, Postgres (Prisma), Redis, Turborepo monorepo, Render deployment.

---

## Phase 0 — Repo, Infra & Deployment

**Goal:** three deployable services exist and talk to each other, nothing functional yet.

### Task 0.1 — Monorepo scaffold
- 0.1.1 Turborepo init with `apps/web`, `apps/api`, `apps/worker`, `apps/desktop`, `packages/agent-core` (Prisma client, OpenRouter wrapper, config loader — shared by `api` and `worker`), `packages/ui` (shared chat components), `packages/shared-types`.
- 0.1.2 Each `apps/*` gets its own `Dockerfile` — no Render buildpacks — so the later k8s migration is "same images, new manifests."
- 0.1.3 Root `tsconfig.json` with path aliases for `packages/*`; verify `apps/api` and `apps/worker` can both import from `packages/agent-core` without duplication.

### Task 0.2 — Config & secrets foundation
- 0.2.1 `packages/agent-core/config.ts` — the *only* module allowed to read `process.env`. Exposes `getConfig()` returning a typed, validated object.
- 0.2.2 `config.schema.ts` — `zod` schema for every required env var (DB URL, Redis URL, JWT secret, OpenRouter key, Nango secret, Sentry DSN, etc.). Boot fails immediately with a clear error if anything's missing/malformed — not a runtime surprise on first use.
- 0.2.3 `.env.example` committed with every key name (no real values) so onboarding doesn't require guessing.

### Task 0.3 — Express server skeleton (`apps/api`)
- 0.3.1 `server.ts` using `http.createServer(app)`, not `app.listen()` — required so socket.io (Phase 2) attaches to the same server instance.
- 0.3.2 `GET /health` — checks Postgres connectivity (`SELECT 1`) and Redis connectivity (`PING`), returns 200 only if both pass. This is the Render health check *and* the future k8s readiness probe — build it once, correctly.

### Task 0.4 — Worker process skeleton (`apps/worker`)
- 0.4.1 Separate entrypoint, no HTTP listener at all — just BullMQ worker registration (queues wired up empty in Phase 3).
- 0.4.2 Same `packages/agent-core` config loader — confirms shared-code import actually works before any real logic depends on it.

### Task 0.5 — Local infra
- 0.5.1 `docker-compose.yml`: Postgres (with `pgvector` extension enabled), Redis.
- 0.5.2 Seed script for local dev — creates one test user so Phase 1 has something to log in as immediately.

### Task 0.6 — Render deployment
- 0.6.1 Four Render services: `web` (Static Site), `api` (Web Service), `worker` (Background Worker), plus managed Postgres and Redis add-ons.
- 0.6.2 Env vars set per-service in Render dashboard, matching `config.schema.ts` exactly — mismatches will fail loudly per 0.2.2.
- 0.6.3 Confirm `api`'s health check path is registered in Render's service settings pointing at `/health`.

**Checkpoint:** `api` and `worker` both boot successfully against Render's managed Postgres/Redis, `/health` returns 200, nothing else built yet.

---

## Phase 1 — Core Chat Loop, Auth, Observability Foundation

**Goal:** real login, a real conversation with a real LLM reply, and logs/traces/errors visible from day one.

### Task 1.1 — Database schema
- 1.1.1 Prisma schema: `User`, `Conversation`, `Message`, `RefreshToken` (full field list per the spec — `Message` includes `role`, `content`, `status`, `toolCalls`, `attachments`, `parentMessageId`, `model`, `tokenCount`, `errorDetail`).
- 1.1.2 Indexes: `Conversation(userId)`, `Message(conversationId, createdAt)`, `RefreshToken(userId)`, unique `RefreshToken.tokenHash`.
- 1.1.3 App-layer enforcement in the user-creation path: reject if both `passwordHash` and `googleId` are null. Add the Postgres trigger backstop in the same migration.
- 1.1.4 First Prisma migration, run against local + Render Postgres.

### Task 1.2 — Observability foundation (built now, not deferred)
- 1.2.1 `pino` structured JSON logging, wired into `apps/api` and `apps/worker`. Middleware generates a `requestId` per HTTP request / `jobId` per BullMQ job, threaded through every log call in that request's lifecycle.
- 1.2.2 OpenTelemetry SDK: instrument Express routes, Prisma queries, and (once it exists in 1.4) OpenRouter calls as spans. Export to Grafana Cloud (free tier).
- 1.2.3 Sentry SDK in both `api` and `worker`, capturing unhandled exceptions.
- 1.2.4 One Grafana dashboard: request latency, error rate, DB query latency — created now so every later phase's work is visible on it automatically.

### Task 1.3 — Auth: password + Google OAuth
- 1.3.1 `POST /auth/register` — bcrypt hash (cost factor 12), creates `User`.
- 1.3.2 `POST /auth/login` — verifies bcrypt hash, issues access token (JWT, `{sub: userId}`, 7-day expiry, httpOnly/`Secure`/`SameSite=Lax` cookie `access_token`) and refresh token (opaque 256-bit random, SHA-256 hashed into `RefreshToken`, 30-day expiry, httpOnly cookie `refresh_token` scoped to `/auth/refresh`).
- 1.3.3 `POST /auth/refresh` — validates refresh token against `RefreshToken.tokenHash`, issues new access+refresh pair, sets old token's `revokedAt`. If an already-revoked token is presented, revoke the entire token family for that user and force re-login (theft-detection behavior).
- 1.3.4 `GET /auth/google` + `GET /auth/google/callback` — standard OAuth consent flow, finds-or-creates `User` by `googleId`, issues the same token pair as 1.3.2 so downstream code never branches on auth method.
- 1.3.5 Rate limiting middleware on `/auth/login`: Redis-backed, 5 attempts / 15 min per `(IP, email)` pair, `429` + `Retry-After` on breach.
- 1.3.6 Auth middleware — validates `access_token` cookie on protected routes, attaches `userId` to request context.

### Task 1.4 — `POST /message` route
- 1.4.1 Request validation: `{ conversationId, content, clientMessageId (UUID) }`.
- 1.4.2 Idempotency: upsert on `(conversationId, clientMessageId)` — retried request with the same ID returns the original result.
- 1.4.3 `packages/agent-core/openrouter.ts` — the OpenRouter call wrapper. One internal retry on 5xx/timeout before surfacing an error. 30-second timeout.
- 1.4.4 Model selection reads from `packages/agent-core/model-config.json` by use-case key (`chat_response` for this route) — never a hardcoded model string.
- 1.4.5 Full response/error contract per the spec: `200` with `{message, usage}`; `400/401/429/502/504` with `{error: {code, message, ...}}`.
- 1.4.6 Write the assistant's `Message` row (with `model`, `tokenCount`) in the same transaction as returning the response.

### Task 1.5 — Frontend chat UI (`apps/web`)
- 1.5.1 Login/register pages (email+password and "Continue with Google" button).
- 1.5.2 Single persistent thread view — no "new conversation" button.
- 1.5.3 Calls `/message` with a generated `clientMessageId`; on network failure, retries the *same* `clientMessageId` (relies on 1.4.2's idempotency, not a new message).
- 1.5.4 Client-side typewriter effect over the complete returned response (simulated streaming per the spec — no backend change required for this).
- 1.5.5 `GET /conversation` loads full history on app open.

**Checkpoint:** register or Google-login, have a real conversation, refresh the page, history persists. Logs/traces/errors for all of this are visible in Grafana/Sentry, not just working silently.

---

## Phase 2 — WebSocket Layer

**Goal:** persistent connection works, single-instance only (multi-instance hardening is Phase 10).

### Task 2.1 — socket.io setup
- 2.1.1 Attach socket.io to the same `http.createServer` instance from 0.3.
- 2.1.2 Auth on connect: client sends `access_token` on the socket handshake, server validates the JWT, associates the socket with `userId` in an in-memory `Map<userId, socketId[]>` (explicitly flagged for replacement in Phase 10.1 — don't over-build this yet).
- 2.1.3 Heartbeat: socket.io's built-in ping/pong, default settings — confirm dead connections are actually evicted from the map on `disconnect`.

### Task 2.2 — Client hookup
- 2.2.1 `apps/web` connects on app load, reconnects with backoff on drop (socket.io client default behavior — confirm it's not disabled).
- 2.2.2 Manual `ping`/`pong` test event, no real UI behavior wired yet.

**Checkpoint:** two browser tabs, manual server-side emit, both receive it.

---

## Phase 3 — Redis + BullMQ

**Goal:** queues and workers function in isolation.

### Task 3.1 — Queue definitions (`apps/worker`)
- 3.1.1 `agent-jobs` — payload `{agentId, trigger: 'user_message'|'webhook'|'poll', context?}`, exponential backoff (base 5s), 5 attempts, concurrency 10.
- 3.1.2 `agent-triggers` — repeatable jobs, payload `{agentId, connectionId}`, concurrency 20.
- 3.1.3 `webhook-processing` — payload `{webhookEventId}`, job ID **explicitly set** to `${provider}:${externalId}` (this *is* the idempotency mechanism — don't let BullMQ auto-generate IDs here), same retry policy as 3.1.1.
- 3.1.4 `failed-agent-jobs` — DLQ target for all three queues above after max attempts exhausted.

### Task 3.2 — Redis pub/sub
- 3.2.1 Channel convention: `user-events:{userId}`.
- 3.2.2 Publish/subscribe smoke test between `apps/worker` (publisher) and `apps/api` (subscriber) — confirm the message actually crosses processes, not just in-process.

### Task 3.3 — Wire pub/sub → socket.io
- 3.3.1 On `user-events:{userId}` message, look up sockets from 2.1.2's map, emit.

**Checkpoint:** manual publish script → message arrives in browser via socket. Pure plumbing, no agent logic yet.

---

## Phase 4 — Agent System

**Goal:** the Interaction/Execution Agent split, fully working against a mocked integration.

### Task 4.1 — Schema
- 4.1.1 `Agent` table (per spec: `taskDescription`, `entity`, `status` enum, `embedding` pgvector column, `ownerConversationId`, `lastActiveAt`).
- 4.1.2 `AgentEvent` table (`agentId`, `eventType`, `payload` jsonb, `createdAt`), indexed `(agentId, createdAt)`.
- 4.1.3 `pgvector` extension confirmed enabled (should already be true from 0.5.1 — verify in this environment too).

### Task 4.2 — Interaction Agent — classification
- 4.2.1 Structured tool-call output: `{action, targetAgentId, taskDescription, confidence}` per the exact schema in the spec.
- 4.2.2 Fallback rule: `confidence < 0.5` or parse failure → force `answer_directly`.
- 4.2.3 Separate, lightweight LLM call (own `model-config.json` key: `classification`) — not fused with response generation.

### Task 4.3 — Dedup check
- 4.3.1 Embedding generation on every `spawn_agent` classification (`text-embedding-3-small`, same model as Phase 12's roster search — implement once, reuse).
- 4.3.2 `pgvector` cosine similarity query against the user's active agents, threshold 0.85.
- 4.3.3 On match: don't auto-merge — return `possibleDuplicateOf` in the classification response so the Interaction Agent asks the user to confirm.

### Task 4.4 — Spawn flow (outbox pattern)
- 4.4.1 `OutboxEvent` table (`id`, `eventType`, `payload`, `processedAt`).
- 4.4.2 Single Postgres transaction: insert `Agent` row + insert `OutboxEvent` row together.
- 4.4.3 Relay process (lives in `apps/worker`) polls `OutboxEvent` for unprocessed rows every few seconds, enqueues the actual BullMQ job, marks `processedAt`.
- 4.4.4 Confirm: kill Redis mid-spawn in a test, restart it, confirm the outbox relay still enqueues the job that was "lost."

### Task 4.5 — Agent execution flow
- 4.5.1 On `agent-jobs` pickup: load `Agent.contextSummary` (if set) + last 40 `AgentEvent` rows or 8,000 tokens (whichever smaller) as context.
- 4.5.2 LLM call via `model-config.json`'s `agent_execution` key.
- 4.5.3 Write result to `AgentEvent` **and** append to `Message`/`Conversation` — Postgres write completes before anything else happens (no publish-before-write).
- 4.5.4 Once agent event history exceeds the 40/8k budget, fold older events into `Agent.contextSummary` via a summarization call — same pattern as Phase 8's conversation summarization, scoped per-agent.

### Task 4.6 — Publish after write
- 4.6.1 After 4.5.3's write succeeds, publish lightweight `{event: 'new_message', conversationId}` to `user-events:{userId}` (Phase 3.3 picks it up).

### Task 4.7 — Filter-before-surfacing
- 4.7.1 Structured LLM call: `{surface: boolean, rationale: string, category: 'actionable'|'fyi'|'noise'}`.
- 4.7.2 Always write to `AgentEvent` with `eventType: 'surfaced'` or `'discarded'` — the discard path is not skipped, ever.
- 4.7.3 Only `surface: true` events proceed to 4.6's publish step.

### Task 4.8 — Dormancy
- 4.8.1 Daily scheduled job: mark `Agent.status = 'dormant'` after 7 days with no new `AgentEvent`.
- 4.8.2 Dormant agents excluded from 4.3's dedup candidates and from Phase 6's polling.

**Checkpoint:** the "check email from Alice" flow works end to end against a mocked Gmail response — classification, dedup, spawn, execution, filter, delivery, all real except the integration call itself.

---

## Phase 5 — Integrations (MCP + Connection Provider)

**Goal:** real Gmail access via Nango, behind a swappable abstraction.

### Task 5.1 — Connection Provider abstraction
- 5.1.1 `packages/connection-provider/types.ts` — the `ConnectionProvider` interface exactly as specified (`initiateOAuth`, `handleCallback`, `getConnection`, `getAccessToken`, `revoke`).
- 5.1.2 `packages/connection-provider/nango-provider.ts` — implements the interface using Nango's SDK. This is the *only* file that imports Nango directly.
- 5.1.3 `IntegrationConnection` table (`userId`, `provider`, `nangoConnectionId`, `status`), unique on `nangoConnectionId`.

### Task 5.2 — OAuth flow (Gmail)
- 5.2.1 `POST /integrations/gmail/connect` → `ConnectionProvider.initiateOAuth` → redirect.
- 5.2.2 `GET /integrations/gmail/callback` → `ConnectionProvider.handleCallback` → writes `IntegrationConnection` row.
- 5.2.3 UI: connect button + status indicator per integration.

### Task 5.3 — MCP server for Gmail
- 5.3.1 `apps/mcp-gmail` — tool definitions (list messages, get thread, etc.), calling `ConnectionProvider.getAccessToken(connectionId)` before every Gmail API call — never touches Nango directly.
- 5.3.2 Structured error mapping: Gmail API errors → `ConnectionError` (expired/revoked/refresh_failed) or `ToolError` (rate_limited/validation_failed/provider_down/malformed_response) per the exact type definitions in the spec.

### Task 5.4 — Agent error-handling decision logic
- 5.4.1 Deterministic priority order in `packages/agent-core`: `rate_limited` → retry w/ backoff up to 3x; `provider_down` → retry once then surface; `validation_failed` → surface immediately (non-retryable); `malformed_response` → retry once then surface.
- 5.4.2 `ConnectionError` handling: mark `IntegrationConnection.status = 'expired'`, surface a "please reconnect" message — no silent retry loop.

### Task 5.5 — Swap the mock
- 5.5.1 Replace Phase 4's mocked Gmail response with real calls through `apps/mcp-gmail`.

**Checkpoint:** the Alice flow works against a real Gmail inbox.

---

## Phase 6 — Event Watching

**Goal:** efficient, correctly-deduplicated event detection — webhook-first, polling fallback.

### Task 6.1 — Webhook infrastructure
- 6.1.1 `WebhookEvent` table (`provider`, `externalId`, `rawPayload`, `processedAt`), unique `(provider, externalId)`.
- 6.1.2 Signature verification per provider *before* any DB write: Google Pub/Sub JWT verification, GitHub HMAC-SHA256, Slack signing secret. Failed verification → `401`, nothing stored.
- 6.1.3 Replay protection: reject payloads with a provider timestamp older than 5 minutes.
- 6.1.4 On verified receipt: `INSERT ... ON CONFLICT (provider, externalId) DO NOTHING` into `WebhookEvent`, then enqueue `webhook-processing` with job ID `${provider}:${externalId}` (Phase 3.1.3's mechanism).

### Task 6.2 — Gmail push setup
- 6.2.1 Register Gmail `watch()` per connected user, pointed at a Cloud Pub/Sub topic wired to `POST /webhooks/gmail`.
- 6.2.2 Renewal job — Gmail watch subscriptions expire (~7 days), scheduled job re-registers before expiry.

### Task 6.3 — Reconciliation backstop
- 6.3.1 Even for webhook-covered connections, a 30-minute reconciliation poll — cheap safety net for missed deliveries during receiver downtime.

### Task 6.4 — Polling fallback (non-webhook providers)
- 6.4.1 Per-`IntegrationConnection` repeatable job, adaptive interval: start 60s, ×2 backoff per empty check, cap 15 min, reset to 60s on new activity found.
- 6.4.2 Poll fans out in-memory to all active agents matching that connection (by `entity`) — one poll, many agents, not one poll per agent.
- 6.4.3 Dormant agents' connections excluded entirely (ties to 4.8.2).

**Checkpoint:** simulate webhook delivery + polling side by side; confirm no duplicate agent executions from either path, and duplicate webhook deliveries are true no-ops.

---

## Phase 7 — Delivery Fallback

**Goal:** the wake-up path when nobody's connected.

### Task 7.1 — Web Push (website)
- 7.1.1 VAPID key generation, `PushSubscription` table, service worker registration in `apps/web`.
- 7.1.2 Subscribe/unsubscribe UI + backend routes.

### Task 7.2 — Tauri native notifications (desktop)
- 7.2.1 `tauri-plugin-notification` wired to the same delivery decision point as 7.4.

### Task 7.3 — Email digest fallback
- 7.3.1 Batches recent surfaced events (not one email per event) — triggered when push delivery isn't available/configured for a user.

### Task 7.4 — Delivery decision logic (single place)
- 7.4.1 One function in `packages/agent-core`: live socket (Phase 3.3)? → send. No socket → push (7.1/7.2). No push subscription or push unconfirmed after a fixed 10-second window [explicit value, not left implicit] → email digest (7.3).

**Checkpoint:** close the app entirely, trigger an event, confirm notification/email arrives.

---

## Phase 8 — Context Management at Scale

**Goal:** thread and agent history stay usable as they grow. Build against real data from Phases 1–7, not synthetic data.

### Task 8.1 — Conversation summarization
- 8.1.1 `ConversationSummary` table (`conversationId`, `summaryText`, `coversMessagesUpTo`, `createdAt`).
- 8.1.2 Threshold trigger: 150 messages, BullMQ job (not inline on the request path).
- 8.1.3 Context construction for replies: last 50 messages full-fidelity + latest summary covering everything before.
- 8.1.4 Raw messages are never deleted — summarization only changes what's included in the active context window.

### Task 8.2 — Concurrency safety
- 8.2.1 Summarization job acquires the same per-conversation Postgres advisory lock as Phase 10.2 before running.

### Task 8.3 — Roster semantic search
- 8.3.1 Activates once a user's active agent count exceeds 20 — below that, load the full roster directly.
- 8.3.2 `pgvector` query replacing full-roster load in Phase 4.2's classification context, once active.

**Checkpoint:** seed a test account with 200+ messages and 25+ agents, confirm response latency holds.

---

## Phase 9 — Desktop App (Tauri)

**Goal:** same web UI, native shell. Last "new surface" phase — web must be fully functional first.

### Task 9.1 — Shell setup
- 9.1.1 Tauri wraps the unmodified `apps/web` static export.
- 9.1.2 Auth token handling: since Tauri's webview cookie jar isn't equivalent to a browser's, access/refresh tokens are attached as headers via Tauri's `invoke` bridge instead of relying on cookies.

### Task 9.2 — Native behavior
- 9.2.1 Tray icon + hide-on-close (`tauri-plugin-notification` dependency for 7.2).
- 9.2.2 Autostart plugin.
- 9.2.3 Global shortcut to summon window.
- 9.2.4 Stronghold/keychain storage for the token pair from 9.1.2.
- 9.2.5 Auto-updater plugin.

**Checkpoint:** desktop app in the tray receives a live-delivered event exactly like an open browser tab did in Phase 2/4.

---

## Phase 10 — Production Hardening

**Goal:** survive multi-instance deployment and real concurrent load.

### Task 10.1 — Socket registry for multi-instance
- 10.1.1 Replace 2.1.2's in-memory map with Redis (`SADD user-sockets:{userId} {instanceId}:{socketId}`, TTL + heartbeat refresh, `SREM` on disconnect).
- 10.1.2 socket.io Redis adapter for cross-instance event forwarding.

### Task 10.2 — Per-conversation locking
- 10.2.1 `pg_advisory_xact_lock(hashtext(conversationId))` wrapping any write path touching a conversation (live reply, agent update, summarization) — auto-released at transaction end.

### Task 10.3 — Redis durability
- 10.3.1 Confirm Render Redis add-on's persistence settings (AOF); if not configurable on the managed tier, document the gap explicitly rather than assuming it's covered.

### Task 10.4 — Cost controls
- 10.4.1 `UsageRecord` table, updated in the same transaction as every LLM call inside `packages/agent-core/openrouter.ts` (single enforcement point).
- 10.4.2 Soft limit (80% of $5/day default) → warning logged + surfaced in-app. Hard limit (100%) → `429 BUDGET_EXCEEDED` on `/message`; background agent jobs pause and retry next window rather than dropping.

### Task 10.5 — Multi-tenancy enforcement
- 10.5.1 Prisma middleware injecting `WHERE userId = ctx.currentUserId` on every user-scoped query.
- 10.5.2 Postgres RLS policies on every user-scoped table, keyed to a `SET app.current_user_id` session variable set per request transaction — independent backstop to 10.5.1.

### Task 10.6 — Load testing
- 10.6.1 Load test Phase 6's polling fan-out under a realistic user/connection ratio (not just the 50-agent simulation from Phase 6's own checkpoint).
- 10.6.2 Tune BullMQ concurrency values (Phase 3.1's "10"/"20" starting points) based on actual results.

**Checkpoint:** run two `api` instances behind Render's load balancer, confirm event delivery, locking, and RLS all hold under concurrent multi-user load.

---

## Phase 11 — Launch Readiness

### Task 11.1 — End-to-end verification
- 11.1.1 Full Alice flow, chained: message → classify → dedup check → spawn (outbox) → poll/webhook → filter → Postgres write → publish → socket delivery → fallback path when disconnected.

### Task 11.2 — Error handling audit
- 11.2.1 Confirm every failure mode named in Phases 4–8 (LLM failure mid-job, malformed webhook, token refresh failure, budget exceeded, lock contention) has an observable outcome — not just a caught exception with no trace.

### Task 11.3 — Alerting finalization
- 11.3.1 Grafana alert rules live: `failed-agent-jobs` non-empty, `/health` failing >2 min, SLO burn-rate breach (message p95 > 3s, job lag p95 > 60s, webhook-to-surfaced p95 > 2 min) — all routed to Slack.

**Checkpoint:** launch.

---

### Notes for implementers (human or AI agent)

- Every table/column name, threshold, and error code above is final — don't re-derive or rename during implementation. If a value seems wrong once real data exists (thresholds in Phases 4, 6, 8, 10 especially), change it in the doc first, then the code.
- Phases 1–4 are the priority path to a working internal demo. Phases 8 and 10 are deliberately last — they tune behavior you can't correctly tune without real usage data from the earlier phases running.
