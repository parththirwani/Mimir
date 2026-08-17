import { getPrismaClient } from "@mimir/backend-core";
import { requireAuth } from "../auth/auth.js";
import type { Request, Response } from "express";
import { Router } from "express";

// User-level preferences. One endpoint, one field today: the browser-reported
// IANA timezone, so the worker can localize surfaced timestamps. Stored as a
// plain string; validated at use time (the worker falls back to ISO on garbage).

export const userRouter: Router = Router();

userRouter.post("/user/timezone", requireAuth, async (req: Request, res: Response) => {
  const prisma = getPrismaClient();
  const userId = (req as Request & { userId?: string }).userId as string;
  const { timeZone } = (req.body ?? {}) as { timeZone?: unknown };
  if (typeof timeZone !== "string" || timeZone.length === 0 || timeZone.length > 64) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "timeZone is required" } });
    return;
  }
  await prisma.user.update({ where: { id: userId }, data: { timezone: timeZone } });
  res.json({ ok: true });
});