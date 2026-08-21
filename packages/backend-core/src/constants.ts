// Tunable values live here, never inline in app code.
// Import from "@mimir/backend-core" (main entry) or, if the importing module
// must stay side-effect-free (e.g. pure token helpers), use the subpath
// "@mimir/backend-core/constants".

// Auth — token lifetimes & cookie placement
export const ACCESS_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const REFRESH_TOKEN_COOKIE_PATH = "/api/v1/auth/refresh";

// Auth — password hashing & brute-force protection
export const BCRYPT_COST = 12;
export const LOGIN_RATE_MAX = 5;
export const LOGIN_RATE_WINDOW_SECONDS = 15 * 60;

// Auth — Google OAuth
export const GOOGLE_STATE_MAX_AGE_MS = 10 * 60 * 1000;

// Agent system — tunables for dedup, execution context, and dormancy
export const AGENT_DEDUP_THRESHOLD = 0.85; // cosine similarity; >= => possible duplicate
export const AGENT_CONTEXT_MAX_EVENTS = 40; // last N AgentEvents as execution context
export const AGENT_CONTEXT_MAX_TOKENS = 8000; // whichever of events/tokens is smaller wins
export const AGENT_DORMANCY_DAYS = 7; // no AgentEvent for this long => dormant

// A mail judged "noise" is held briefly, then re-judged. The filter is cheap
// (gpt-4o-mini) and imperfect; a permanent claim would silently drop a real
// meeting invite on one bad call. 24h bounds the re-judge cost per mail.
export const MAIL_NOISE_TTL_SECONDS = 24 * 60 * 60;

// Hosted browser sessions cost real money per minute. Keep the cap low enough
// that a runaway loop can't produce a surprise bill.
export const BROWSER_DAILY_MINUTES_CAP = 30; // per-user per-day hosted-browser minutes

// Reflector — generate + evaluate loop for complex tasks.
export const REFLECTOR_MAX_ATTEMPTS = 3; // cap on generate+eval rounds; exhaust => best-scoring attempt surfaces
export const REFLECTOR_TIME_BUDGET_MS = 60_000; // whole-loop budget = 2x the 30s transport ceiling; forces early exit

// Planning — replan cap for a complex run whose step fails.
export const PLAN_REPLAN_CAP = 2; // total attempts: initial plan + up to 1 replan; exhaust => partial progress + explicit failure

// Max concurrent worker steps per parallel group. Bounds a single user turn's
// fan-out so it can't open unbounded parallel LLM calls.
export const MAX_PARALLEL_WORKERS = 5;

// Hardening — per-step wall-clock ceiling so one hung worker (no throw, no
// resolve) can't block the whole batch and thus the whole task forever.
// 2 minutes is well above a legitimate step's tool loop (30s transport ceiling
// x MAX_TOOL_DEPTH turns) but bounds a runaway/garbage step.
export const PLAN_STEP_TIMEOUT_MS = 120_000;

// Hardening — cap each worker output's contribution to the aggregation call
// (and its concatenation fallback) so one giant/binary worker can't blow
// the surface tier's context budget or balloon the final reply. Tunable.
export const AGGREGATE_OUTPUT_MAX_CHARS = 8000;

// How many active ExtractedFacts to inject into reply context on a top-K embedding
// search. Bounded to keep prompt context lean.
export const FACT_EXTRACTION_TOP_K = 5;

// Cosine-similarity floor before routing a same-subject fact pair to the
// contradiction judge. The subject match is the real discriminator (different
// things get different subjects); this is only a floor to avoid spending a judge
// call on trivially orthogonal completions under one subject. Set LOW: facts are
// short texts with naturally lower cosine sim than the long-document value
// AGENT_DEDUP_THRESHOLD (0.85) was built for — a high bar silently skips real
// contradictions ("rent $1200" -> "rent $1500" can sit well below 0.8).
export const FACT_NEAR_THRESHOLD = 0.4;
