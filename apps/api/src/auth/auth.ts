import {
  ACCESS_TOKEN_TTL_SECONDS,
  BCRYPT_COST,
  getConfig,
  getLogger,
  getPrismaClient,
  GOOGLE_STATE_MAX_AGE_MS,
  LOGIN_RATE_MAX,
  LOGIN_RATE_WINDOW_SECONDS,
  REFRESH_TOKEN_COOKIE_PATH,
  REFRESH_TOKEN_TTL_SECONDS,
  trackEvent,
} from "@mimir/backend-core";
import { credentialsSchema } from "@mimir/zod-schemas";
import { createHash, randomBytes } from "node:crypto";
import { NextFunction, Request, Response, Router } from "express";
import passport from "passport";
import { redis } from "../infra/redis.js";
import { generateRefreshToken, parseCookies, signAccessToken, verifyAccessToken } from "./tokens.js";
import "./google-auth.js";

/* eslint-disable @typescript-eslint/no-namespace -- Express Request augmentation requires it */
declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}
/* eslint-enable @typescript-eslint/no-namespace */

const cfg = getConfig();
const prisma = getPrismaClient();

export const authRouter: Router = Router();

function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  const secure = cfg.NODE_ENV === "production";
  res.cookie("access_token", accessToken, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
  });
  res.cookie("refresh_token", refreshToken, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: REFRESH_TOKEN_COOKIE_PATH,
    maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
  });
}

async function createRefreshToken(userId: string): Promise<string> {
  const { token, hash } = generateRefreshToken();
  await prisma.refreshToken.create({
    data: { userId, tokenHash: hash, expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000) },
  });
  return token;
}

async function issueTokens(res: Response, userId: string): Promise<void> {
  const [accessToken, refreshToken] = await Promise.all([
    signAccessToken(userId, cfg.JWT_SECRET),
    createRefreshToken(userId),
  ]);
  setAuthCookies(res, accessToken, refreshToken);
}

async function loginRetryAfterSeconds(ip: string, email: string): Promise<number | null> {
  const key = `auth:login:${ip}:${email}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, LOGIN_RATE_WINDOW_SECONDS);
    if (count > LOGIN_RATE_MAX) {
      const ttl = await redis.ttl(key);
      return ttl > 0 ? ttl : LOGIN_RATE_WINDOW_SECONDS;
    }
    return null;
  } catch (e) {
    // Redis is already degraded; fail open rather than lock every user out.
    getLogger().error({ err: e }, "login rate limiter failed; failing open");
    return null;
  }
}

authRouter.post("/register", async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid email or password" } });
    return;
  }
  const { email, password } = parsed.data;
  if (await prisma.user.findUnique({ where: { email } })) {
    res.status(409).json({ error: { code: "EMAIL_TAKEN", message: "An account with this email already exists" } });
    return;
  }
  const passwordHash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: BCRYPT_COST });
  const user = await prisma.user.create({ data: { email, passwordHash } });
  await issueTokens(res, user.id);
  getLogger().info({ userId: user.id }, "user registered");
  await trackEvent(user.id, "auth_register", { provider: "email" });
  res.status(201).json({ user: { id: user.id, email: user.email } });
});

authRouter.post("/login", async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid email or password" } });
    return;
  }
  const { email, password } = parsed.data;
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const retryAfter = await loginRetryAfterSeconds(ip, email);
  if (retryAfter !== null) {
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many login attempts" } });
    return;
  }
  const user = await prisma.user.findUnique({ where: { email } });
  const ok = user?.passwordHash != null && (await Bun.password.verify(password, user.passwordHash));
  if (!ok) {
    res.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" } });
    return;
  }
  await issueTokens(res, user.id);
  getLogger().info({ userId: user.id }, "user logged in");
  await trackEvent(user.id, "auth_login", { provider: "email" });
  res.json({ user: { id: user.id, email: user.email } });
});

authRouter.post("/refresh", async (req, res) => {
  const token = parseCookies(req.headers.cookie).refresh_token;
  if (!token) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing refresh token" } });
    return;
  }
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!stored || stored.expiresAt <= new Date()) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Invalid refresh token" } });
    return;
  }
  if (stored.revokedAt) {
    getLogger().warn({ userId: stored.userId }, "revoked refresh token presented; revoking token family");
    await prisma.refreshToken.updateMany({ where: { userId: stored.userId }, data: { revokedAt: new Date() } });
    res.clearCookie("refresh_token", { path: REFRESH_TOKEN_COOKIE_PATH });
    res.clearCookie("access_token", { path: "/" });
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Session expired, please log in again" } });
    return;
  }
  await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
  await issueTokens(res, stored.userId);
  getLogger().info({ userId: stored.userId }, "refresh token rotated");
  res.json({ ok: true });
});

authRouter.post("/logout", async (req, res) => {
  const token = parseCookies(req.headers.cookie).access_token;
  if (token) {
    const userId = await verifyAccessToken(token, cfg.JWT_SECRET);
    if (userId) {
      await prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      getLogger().info({ userId }, "user logged out");
      await trackEvent(userId, "auth_logout");
    }
  }
  res.clearCookie("access_token", { path: "/" });
  res.clearCookie("refresh_token", { path: REFRESH_TOKEN_COOKIE_PATH });
  res.json({ ok: true });
});

function googleConfigured(): boolean {
  return Boolean(cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET && cfg.GOOGLE_REDIRECT_URI);
}

authRouter.get("/google", (req, res, next) => {
  if (!googleConfigured()) {
    getLogger().warn("google oauth requested but not configured");
    res.status(503).json({ error: { code: "NOT_CONFIGURED", message: "Google auth is not configured" } });
    return;
  }
  getLogger().info("google oauth initiated");
  const state = randomState();
  res.cookie("oauth_state", state, {
    httpOnly: true,
    secure: cfg.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: GOOGLE_STATE_MAX_AGE_MS,
  });
  passport.authenticate("google", { scope: ["openid", "email", "profile"], state })(req, res, next);
});

authRouter.get("/google/callback", (req, res, next) => {
  if (!googleConfigured()) {
    res.status(503).json({ error: { code: "NOT_CONFIGURED", message: "Google auth is not configured" } });
    return;
  }
  const stateCookie = parseCookies(req.headers.cookie).oauth_state;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  if (!state || !stateCookie || state !== stateCookie) {
    res.clearCookie("oauth_state", { path: "/" });
    res.status(400).json({ error: { code: "OAUTH_ERROR", message: "Invalid state" } });
    return;
  }
  passport.authenticate(
    "google",
    { session: false },
    (err: Error & { code?: string } | null, user?: { id: string } | null, info?: { message?: string }) => {
      res.clearCookie("oauth_state", { path: "/" });
      if (err) {
        getLogger().error({ err }, "google authentication error");
        const status = err.code === "EMAIL_TAKEN" ? 409 : 400;
        res.status(status).json({
          error: { code: err.code ?? "OAUTH_ERROR", message: err.message ?? "Google authentication failed" },
        });
        return;
      }
      if (!user) {
        getLogger().error({ message: info?.message }, "google authentication failed");
        res.status(502).json({ error: { code: "OAUTH_ERROR", message: "Google authentication failed" } });
        return;
      }
      issueTokens(res, user.id)
        .then(async () => {
          getLogger().info({ userId: user.id }, "user logged in via google");
          await trackEvent(user.id, "auth_login", { provider: "google" });
          res.redirect(`${cfg.WEB_APP_URL ?? ""}/chat`);
        })
        .catch((e) => {
          getLogger().error({ err: e }, "failed to issue tokens after google login");
          res.status(500).json({ error: { code: "OAUTH_ERROR", message: "Login failed" } });
        });
    },
  )(req, res, next);
});

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = parseCookies(req.headers.cookie).access_token;
  const userId = token ? await verifyAccessToken(token, cfg.JWT_SECRET) : null;
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  // The JWT only proves the signature, not that the user still exists — an
  // orphaned-but-unexpired token (e.g. after a DB reset) passed auth and then
  // died as an FK violation on the first write (Conversation.create). Verify the
  // row so stale sessions bounce to login instead of 500ing mid-request.
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) {
    getLogger().warn({ userId }, "session refers to a missing user; clearing cookies");
    res.clearCookie("access_token", { path: "/" });
    res.clearCookie("refresh_token", { path: REFRESH_TOKEN_COOKIE_PATH });
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  req.userId = userId;
  next();
}

function randomState(): string {
  return randomBytes(16).toString("base64url");
}
