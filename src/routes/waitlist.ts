import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { Role, WaitlistRole } from "@prisma/client";
import { prisma } from "../lib/db.js";
import { requireAuth, requireRole, wrap } from "../middleware/auth.js";
import { parsePagination, paginationMeta } from "../lib/pagination.js";
import { sendEmail } from "../lib/email.js";

export const waitlistRouter = Router();

const approveSchema = z.object({
  role: z.enum(["OWNER", "FUNDER", "CARRIER", "ADMIN"], { message: "Select a role." }),
  organizationName: z.string().trim().optional(),
  organizationId: z.string().trim().optional(),
});

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
  wrap(async (req, res) => {
    const { page, pageSize, skip, take } = parsePagination(req.query);
    const [rows, total] = await Promise.all([
      prisma.waitlistSignup.findMany({ orderBy: { createdAt: "desc" }, skip, take }),
      prisma.waitlistSignup.count(),
    ]);
    res.json({ waitlist: rows, ...paginationMeta(total, page, pageSize) });
  }),
);

waitlistRouter.post(
  "/:id/approve",
  requireAuth,
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    const row = await prisma.waitlistSignup.findUnique({ where: { id: req.params.id as string } });
    if (!row) {
      res.status(404).json({ error: "Waitlist entry not found." });
      return;
    }
    const parsed = approveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request." });
      return;
    }

    const existingUser = await prisma.user.findUnique({ where: { email: row.email } });
    if (existingUser) {
      res.status(400).json({ error: "A user with this email already exists." });
      return;
    }

    let organizationId: string | undefined;
    if (parsed.data.organizationName) {
      const org = await prisma.organization.create({
        data: { name: parsed.data.organizationName, approved: true },
      });
      organizationId = org.id;
    } else if (parsed.data.organizationId) {
      organizationId = parsed.data.organizationId;
    }

    const token = crypto.randomBytes(24).toString("hex");
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const invite = await prisma.invite.create({
      data: {
        token,
        email: row.email,
        name: row.name,
        role: parsed.data.role as Role,
        organizationId,
        waitlistSignupId: row.id,
        expiresAt,
      },
    });

    await prisma.waitlistSignup.update({ where: { id: row.id }, data: { invitedAt: new Date() } });

    const inviteUrl = `${process.env.UI_ORIGIN ?? "http://207.241.172.34:3000"}/register/${token}`;
    const emailSent = await sendEmail({
      to: row.email,
      subject: "You're invited to FiSure",
      text: `Hi ${row.name},\n\nYou've been approved for FiSure. Set up your account here:\n${inviteUrl}\n\nThis link expires in 7 days.`,
    });

    res.status(201).json({ invite, inviteUrl, emailSent });
  }),
)
