import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { prisma } from "../lib/db.js";
import { COOKIE, requireAuth, wrap } from "../middleware/auth.js";
import { publicUser } from "../lib/serialize.js";
import { flags } from "../lib/flags.js";
import { failKycAndRefund } from "../lib/kyc.js";

export const authRouter = Router();

function cookieOptions() {
  const days = Number(process.env.SESSION_DAYS ?? 7);
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: false,
    path: "/",
    maxAge: days * 24 * 60 * 60 * 1000,
  };
}

authRouter.post(
  "/login",
  wrap(async (req, res) => {
    const email = String(req.body?.email ?? "")
      .trim()
      .toLowerCase();
    const password = String(req.body?.password ?? "");
    const user = await prisma.user.findUnique({
      where: { email },
      include: { memberships: { include: { organization: true } } },
    });
    if (!user?.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
      res.status(401).json({ error: "Email or password is incorrect." });
      return;
    }
    const sessionToken = crypto.randomBytes(32).toString("hex");
    const expires = new Date();
    expires.setDate(expires.getDate() + Number(process.env.SESSION_DAYS ?? 7));
    await prisma.session.create({
      data: { sessionToken, userId: user.id, expires },
    });
    res.cookie(COOKIE, sessionToken, cookieOptions());
    res.json({ user: publicUser(user) });
  }),
);

authRouter.post(
  "/logout",
  wrap(async (req, res) => {
    const token = req.cookies?.[COOKIE] as string | undefined;
    if (token) {
      await prisma.session.deleteMany({ where: { sessionToken: token } });
    }
    res.clearCookie(COOKIE, { path: "/" });
    res.json({ ok: true });
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  wrap(async (req, res) => {
    res.json({ user: publicUser(req.user!) });
  }),
);

authRouter.post(
  "/simulate-kyc",
  requireAuth,
  wrap(async (req, res) => {
    if (!flags.paymentsSimulate) {
      res.status(400).json({ error: "Simulated identity checks are disabled." });
      return;
    }
    const outcome = req.body?.outcome === "FAIL" ? "FAILED" : "PASSED";

    if (outcome === "FAILED") {
      await failKycAndRefund(req.user!.id);
    } else {
      await prisma.user.update({
        where: { id: req.user!.id },
        data: { kycStatus: "PASSED" },
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { memberships: { include: { organization: true } } },
    });
    res.json({ user: publicUser(user!) });
  }),
);
