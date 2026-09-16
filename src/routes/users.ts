import { Router } from "express";
import { z } from "zod";
import { Role } from "@prisma/client";
import { prisma } from "../lib/db.js";
import { requireAuth, requireRole, wrap } from "../middleware/auth.js";
import { parsePagination, paginationMeta } from "../lib/pagination.js";

export const usersRouter = Router();

usersRouter.get(
  "/",
  requireAuth,
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    const { page, pageSize, skip, take } = parsePagination(req.query);
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          kycStatus: true,
          carrierId: true,
          disabledAt: true,
          lastLoginAt: true,
          createdAt: true,
        },
      }),
      prisma.user.count(),
    ]);
    res.json({ users, ...paginationMeta(total, page, pageSize) });
  }),
);

const patchSchema = z.object({
  role: z.enum(["OWNER", "FUNDER", "CARRIER", "ADMIN"]).optional(),
  disabledAt: z.boolean().optional(),
});

usersRouter.patch(
  "/:id",
  requireAuth,
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    const id = req.params.id as string;
    if (id === req.user!.id) {
      res.status(400).json({ error: "You cannot change your own role or status." });
      return;
    }
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request." });
      return;
    }
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) {
      res.status(404).json({ error: "User not found." });
      return;
    }

    const data: { role?: Role; disabledAt?: Date | null } = {};
    if (parsed.data.role) data.role = parsed.data.role as Role;
    if (parsed.data.disabledAt !== undefined) {
      data.disabledAt = parsed.data.disabledAt ? new Date() : null;
    }

    const user = await prisma.user.update({ where: { id }, data });

    if (data.disabledAt) {
      await prisma.session.deleteMany({ where: { userId: id } });
    }

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        kycStatus: user.kycStatus,
        carrierId: user.carrierId,
        disabledAt: user.disabledAt,
        createdAt: user.createdAt,
      },
    });
  }),
);

usersRouter.delete(
  "/:id",
  requireAuth,
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    const id = req.params.id as string;
    if (id === req.user!.id) {
      res.status(400).json({ error: "You cannot remove your own account." });
      return;
    }
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) {
      res.status(404).json({ error: "User not found." });
      return;
    }

    const [propertyCount, contributionCount] = await Promise.all([
      prisma.property.count({ where: { ownerId: id } }),
      prisma.contribution.count({ where: { userId: id } }),
    ]);
    if (propertyCount > 0 || contributionCount > 0) {
      res.status(400).json({
        error: "This user has properties or contributions on file and can't be removed. Deactivate the account instead.",
      });
      return;
    }

    await prisma.user.delete({ where: { id } });
    res.json({ ok: true });
  }),
);
