import { Router } from "express";
import { WaitlistRole } from "@prisma/client";
import { prisma } from "../lib/db.js";
import { requireAuth, requireRole, wrap } from "../middleware/auth.js";

export const waitlistRouter = Router();

const ROLE_MAP: Record<string, WaitlistRole> = {
  owner: "OWNER",
  corporate: "CORPORATE",
  individual: "INDIVIDUAL",
  carrier: "CARRIER",
  other: "OTHER",
  OWNER: "OWNER",
  CORPORATE: "CORPORATE",
  INDIVIDUAL: "INDIVIDUAL",
  CARRIER: "CARRIER",
  OTHER: "OTHER",
};

waitlistRouter.post(
  "/",
  wrap(async (req, res) => {
    const name = String(req.body?.name ?? "").trim();
    const email = String(req.body?.email ?? "")
      .trim()
      .toLowerCase();
    const roleRaw = String(req.body?.role ?? "");
    const disclosure = req.body?.disclosure === true || req.body?.disclosure === "on";
    const role = ROLE_MAP[roleRaw];
    if (!name || name.length < 2 || !email.includes("@") || !role || !disclosure) {
      res.status(400).json({ error: "Please complete every field." });
      return;
    }
    await prisma.waitlistSignup.upsert({
      where: { email_role: { email, role } },
      create: { name, email, role, disclosureAccepted: true },
      update: { name, disclosureAccepted: true },
    });
    res.json({ ok: true });
  }),
);

waitlistRouter.get(
  "/",
  requireAuth,
  requireRole("ADMIN"),
  wrap(async (_req, res) => {
    const rows = await prisma.waitlistSignup.findMany({ orderBy: { createdAt: "desc" } });
    res.json({ waitlist: rows });
  }),
);
