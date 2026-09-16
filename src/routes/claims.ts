import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth, requireRole, wrap } from "../middleware/auth.js";
import { sendNotificationEmails } from "../lib/notify.js";

export const claimsRouter = Router();

const openClaimSchema = z.object({
  policyId: z.string().trim().min(1, "Policy is required."),
  description: z.string().trim().optional().default(""),
});

claimsRouter.get(
  "/",
  requireAuth,
  requireRole("ADMIN", "CARRIER"),
  wrap(async (req, res) => {
    const claims = await prisma.claim.findMany({
      where:
        req.user!.role === "CARRIER" && req.user!.carrierId
          ? { policy: { carrierId: req.user!.carrierId } }
          : {},
      include: { property: true, policy: true },
      orderBy: { openedAt: "desc" },
    });
    res.json({ claims });
  }),
);

claimsRouter.post(
  "/",
  requireAuth,
  requireRole("ADMIN", "CARRIER"),
  wrap(async (req, res) => {
    const parsed = openClaimSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request." });
      return;
    }
    const policy = await prisma.policy.findUnique({
      where: { id: parsed.data.policyId },
      include: { listing: { include: { property: true } } },
    });
    if (!policy) {
      res.status(404).json({ error: "Policy not found." });
      return;
    }
    if (req.user!.role === "CARRIER" && policy.carrierId !== req.user!.carrierId) {
      res.status(403).json({ error: "This policy is not in your book." });
      return;
    }
    const claim = await prisma.claim.create({
      data: {
        propertyId: policy.listing.propertyId,
        policyId: policy.id,
        description: parsed.data.description || null,
      },
    });
    const claimOpenedTitle = "A claim was opened on your policy";
    const claimOpenedBody = `Policy ${policy.policyNumber} now has an open claim. New listings for the same peril are blocked until it's settled.`;
    await prisma.notification.create({
      data: {
        userId: policy.listing.property.ownerId,
        kind: "CLAIM_OPENED",
        title: claimOpenedTitle,
        body: claimOpenedBody,
        listingId: policy.listingId,
        policyId: policy.id,
      },
    });
    await sendNotificationEmails([policy.listing.property.ownerId], claimOpenedTitle, claimOpenedBody);
    res.status(201).json({ claim });
  }),
);

claimsRouter.post(
  "/:id/settle",
  requireAuth,
  requireRole("ADMIN", "CARRIER"),
  wrap(async (req, res) => {
    const claim = await prisma.claim.findUnique({
      where: { id: req.params.id as string },
      include: { policy: { include: { listing: { include: { property: true } } } } },
    });
    if (!claim) {
      res.status(404).json({ error: "Claim not found." });
      return;
    }
    if (req.user!.role === "CARRIER" && claim.policy?.carrierId !== req.user!.carrierId) {
      res.status(403).json({ error: "This claim is not in your book." });
      return;
    }
    const updated = await prisma.claim.update({
      where: { id: claim.id },
      data: { status: "SETTLED", settledAt: new Date() },
    });
    if (claim.policy) {
      const claimSettledTitle = "Your claim was settled";
      const claimSettledBody = `Policy ${claim.policy.policyNumber}'s claim is now settled. You may list again for this peril.`;
      await prisma.notification.create({
        data: {
          userId: claim.policy.listing.property.ownerId,
          kind: "CLAIM_SETTLED",
          title: claimSettledTitle,
          body: claimSettledBody,
          listingId: claim.policy.listingId,
          policyId: claim.policy.id,
        },
      });
      await sendNotificationEmails([claim.policy.listing.property.ownerId], claimSettledTitle, claimSettledBody);
    }
    res.json({ claim: updated });
  }),
);
