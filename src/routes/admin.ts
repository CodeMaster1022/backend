import { Router } from "express";
import { prisma } from "../lib/db.js";
import { requireAuth, requireRole, wrap } from "../middleware/auth.js";
import { flags, canContributeInApp } from "../lib/flags.js";
import { expireOrTopUpListings } from "./listings.js";

export const adminRouter = Router();

adminRouter.get(
  "/flags",
  requireAuth,
  requireRole("ADMIN"),
  wrap(async (_req, res) => {
    res.json({
      flags: {
        ...flags,
        contributeMode: canContributeInApp(),
        database: "sqlite",
        payments: "simulated",
      },
    });
  }),
);

adminRouter.get(
  "/overview",
  requireAuth,
  requireRole("ADMIN"),
  wrap(async (_req, res) => {
    const [listings, waitlist, policies, users] = await Promise.all([
      prisma.listing.count(),
      prisma.waitlistSignup.count(),
      prisma.policy.count(),
      prisma.user.count(),
    ]);
    const byStatus = await prisma.listing.groupBy({
      by: ["status"],
      _count: { status: true },
    });
    res.json({ listings, waitlist, policies, users, byStatus });
  }),
);

adminRouter.post(
  "/expire",
  requireAuth,
  requireRole("ADMIN"),
  wrap(async (_req, res) => {
    const result = await expireOrTopUpListings();
    res.json(result);
  }),
);
