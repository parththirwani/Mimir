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
