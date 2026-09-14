import { Router } from "express";
import { prisma } from "../lib/db.js";
import { requireAuth, wrap } from "../middleware/auth.js";

export const notificationsRouter = Router();

notificationsRouter.get(
  "/",
  requireAuth,
  wrap(async (req, res) => {
    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: req.user!.id },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      prisma.notification.count({ where: { userId: req.user!.id, read: false } }),
    ]);
    res.json({ notifications, unreadCount });
  }),
);

notificationsRouter.post(
  "/:id/read",
  requireAuth,
  wrap(async (req, res) => {
    const notification = await prisma.notification.findUnique({
      where: { id: req.params.id as string },
    });
    if (!notification || notification.userId !== req.user!.id) {
      res.status(404).json({ error: "Notification not found." });
      return;
    }
    await prisma.notification.update({ where: { id: notification.id }, data: { read: true } });
    res.json({ ok: true });
  }),
);

notificationsRouter.post(
  "/read-all",
  requireAuth,
  wrap(async (req, res) => {
    await prisma.notification.updateMany({
      where: { userId: req.user!.id, read: false },
      data: { read: true },
    });
    res.json({ ok: true });
  }),
);
