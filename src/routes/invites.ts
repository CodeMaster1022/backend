import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma, TX_OPTIONS } from "../lib/db.js";
import { COOKIE, wrap } from "../middleware/auth.js";
import { issueSession, sessionCookieOptions } from "../lib/session.js";
import { publicUser } from "../lib/serialize.js";

export const invitesRouter = Router();

function inviteIsUsable(invite: { usedAt: Date | null; expiresAt: Date } | null) {
  return Boolean(invite) && !invite!.usedAt && invite!.expiresAt >= new Date();
}

invitesRouter.get(
  "/:token",
  wrap(async (req, res) => {
    const invite = await prisma.invite.findUnique({ where: { token: req.params.token as string } });
    if (!inviteIsUsable(invite)) {
      res.status(404).json({ error: "This invite link is invalid or has expired." });
      return;
    }
    res.json({ invite: { email: invite!.email, name: invite!.name, role: invite!.role } });
  }),
);

const completeSchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters."),
});

invitesRouter.post(
  "/:token/complete",
  wrap(async (req, res) => {
    const invite = await prisma.invite.findUnique({ where: { token: req.params.token as string } });
    if (!inviteIsUsable(invite)) {
      res.status(400).json({ error: "This invite link is invalid or has expired." });
      return;
    }
    const parsed = completeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request." });
      return;
    }

    const existing = await prisma.user.findUnique({ where: { email: invite!.email } });
    if (existing) {
      res.status(400).json({ error: "An account with this email already exists — sign in instead." });
      return;
    }

    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const userId = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          name: invite!.name,
          email: invite!.email,
          passwordHash,
          role: invite!.role,
        },
      });
      if (invite!.organizationId) {
        await tx.membership.create({
          data: { userId: created.id, organizationId: invite!.organizationId, role: "ADMIN" },
        });
      }
      await tx.invite.update({ where: { id: invite!.id }, data: { usedAt: new Date() } });
      return created.id;
    }, TX_OPTIONS);

    const full = await prisma.user.findUnique({
      where: { id: userId },
      include: { memberships: { include: { organization: true } } },
    });

    const sessionToken = await issueSession(userId);
    res.cookie(COOKIE, sessionToken, sessionCookieOptions());
    res.status(201).json({ user: publicUser(full!) });
  }),
);
