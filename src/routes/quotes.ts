import { Router } from "express";
import { z } from "zod";
import { prisma, TX_OPTIONS } from "../lib/db.js";
import { requireAuth, requireRole, wrap } from "../middleware/auth.js";
import { radiusKmForPeril } from "../lib/labels.js";
import {
  bufferPassed,
  dollarsToCents,
  listingWindow,
  minimumPayableCents,
  requiredCoverageCents,
  suggestedMinimumCoverageCents,
  usd,
} from "../lib/money.js";

export const quotesRouter = Router();

const respondSchema = z.object({
  decision: z.enum(["ACCEPTED", "DECLINED"], { message: "Decision must be ACCEPTED or DECLINED." }),
  notes: z.string().trim().optional().default(""),
  premium: z.union([z.string(), z.number()]).optional().default(0),
  coverage: z.union([z.string(), z.number()]).optional().default(0),
  validDays: z.coerce.number().int().min(1).max(365).optional().default(30),
  ownerDays: z.coerce.number().int().min(1).max(365).optional().default(45),
  trigger: z.string().trim().optional(),
});

quotesRouter.get(
  "/queue",
  requireAuth,
  requireRole("CARRIER", "ADMIN"),
  wrap(async (req, res) => {
    const requests = await prisma.quoteRequest.findMany({
      where:
        req.user!.role === "CARRIER" && req.user!.carrierId
          ? { carrierProduct: { carrierId: req.user!.carrierId } }
          : {},
      include: {
        property: { include: { mortgage: true, owner: { select: { email: true, name: true } } } },
        carrierProduct: true,
        quote: true,
      },
      orderBy: { submittedAt: "desc" },
    });
    res.json({ requests });
  }),
);

quotesRouter.post(
  "/:id/respond",
  requireAuth,
  requireRole("CARRIER", "ADMIN"),
  wrap(async (req, res) => {
    const request = await prisma.quoteRequest.findUnique({
      where: { id: req.params.id as string },
      include: {
        property: { include: { mortgage: true } },
        carrierProduct: true,
        quote: true,
      },
    });
    if (!request) {
      res.status(404).json({ error: "Quote request not found." });
      return;
    }
    if (req.user!.role === "CARRIER" && request.carrierProduct.carrierId !== req.user!.carrierId) {
      res.status(403).json({ error: "This request is not in your book." });
      return;
    }
    if (request.quote) {
      res.status(400).json({ error: "A decision was already recorded." });
      return;
    }

    const parsed = respondSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request." });
      return;
    }
    const { decision, notes, validDays, ownerDays } = parsed.data;

    if (decision === "DECLINED") {
      await prisma.$transaction([
        prisma.quoteRequest.update({
          where: { id: request.id },
          data: { status: "DECLINED" },
        }),
        prisma.quote.create({
          data: { quoteRequestId: request.id, decision: "DECLINED", notes: notes || null },
        }),
      ]);
      res.json({ ok: true });
      return;
    }

    const premiumCents = dollarsToCents(parsed.data.premium);
    const coverageCents = dollarsToCents(parsed.data.coverage);
    const triggerText = parsed.data.trigger?.trim() || request.carrierProduct.triggerDescription;

    if (premiumCents <= 0 || coverageCents <= 0) {
      res.status(400).json({ error: "Premium and coverage are required to accept." });
      return;
    }

    const mortgageCents = request.property.mortgage?.outstandingBalanceCents ?? 0;
    const minPayable = minimumPayableCents(
      coverageCents,
      request.carrierProduct.payoutSchedule,
    );
    const required = requiredCoverageCents(mortgageCents);
    if (!bufferPassed(minPayable, mortgageCents)) {
      let error: string;
      if (!request.carrierProduct.payoutSchedule) {
        error = `Coverage fails the 35% buffer. ${usd(coverageCents)} of coverage is below the required ${usd(required)} (mortgage × 1.35).`;
      } else {
        const suggestion = suggestedMinimumCoverageCents(
          mortgageCents,
          request.carrierProduct.payoutSchedule,
        );
        error = `Coverage fails the 35% buffer. This product's payout schedule caps the minimum payable at ${usd(minPayable)} for ${usd(coverageCents)} of stated coverage — that must be at least ${usd(required)} (mortgage × 1.35). ${
          suggestion.achievable
            ? `Enter at least ${usd(suggestion.coverageCents)} of coverage to clear the minimum payable band.`
            : "This product's payout schedule cannot clear the required buffer at any coverage amount — a fixed-dollar band is set below the required minimum."
        }`;
      }
      res.status(400).json({ error });
      return;
    }

    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + validDays);
    const expiresAt = listingWindow({
      ownerRequestedDays: ownerDays,
      quoteValidUntil: validUntil,
    });

    await prisma.$transaction(async (tx) => {
      await tx.quoteRequest.update({
        where: { id: request.id },
        data: { status: "ACCEPTED" },
      });
      const quote = await tx.quote.create({
        data: {
          quoteRequestId: request.id,
          decision: "ACCEPTED",
          premiumCents,
          coverageCents,
          validUntil,
          triggerJson: {
            text: triggerText,
            radiusKm: radiusKmForPeril(request.property.peril),
          },
          payoutSchedule: request.carrierProduct.payoutSchedule ?? undefined,
          notes: notes || null,
        },
      });
      await tx.listing.create({
        data: {
          propertyId: request.propertyId,
          quoteId: quote.id,
          status: "AWAITING_OWNER_FUNDS",
          premiumTargetCents: premiumCents,
          ownerRequestedDays: ownerDays,
          expiresAt,
        },
      });
      await tx.eligibilityCheck.create({
        data: {
          propertyId: request.propertyId,
          bufferPassed: true,
          kycPassed: true,
          sameRiskCovered: false,
          inRiskZone: true,
          requiredCoverageCents: required,
          proposedCoverageCents: coverageCents,
          notes: "Re-checked at quote using coverage and payout schedule minimum.",
        },
      });
    }, TX_OPTIONS);

    res.json({ ok: true });
  }),
);
