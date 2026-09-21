import { Router } from "express";
import { z } from "zod";
import { prisma, TX_OPTIONS } from "../lib/db.js";
import { requireAuth, requireRole, wrap } from "../middleware/auth.js";
import { radiusKmForPeril } from "../lib/labels.js";
import { parsePagination, paginationMeta } from "../lib/pagination.js";
import { bufferPassed, dollarsToCents, listingWindow, requiredCoverageCents, usd } from "../lib/money.js";

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
    const where =
      req.user!.role === "CARRIER" && req.user!.carrierId
        ? { carrierProduct: { carrierId: req.user!.carrierId } }
        : {};
    const { page, pageSize, skip, take } = parsePagination(req.query);
    const [requests, total] = await Promise.all([
      prisma.quoteRequest.findMany({
        where,
        include: {
          property: {
            include: {
              mortgage: true,
              owner: { select: { email: true, name: true, kycStatus: true } },
              documents: true,
            },
          },
          carrierProduct: true,
          quote: true,
        },
        orderBy: { submittedAt: "desc" },
        skip,
        take,
      }),
      prisma.quoteRequest.count({ where }),
    ]);
    res.json({ requests, ...paginationMeta(total, page, pageSize) });
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
    const propertyValueCents = request.property.estimatedValueCents;
    const required = requiredCoverageCents(mortgageCents);
    if (!bufferPassed(coverageCents, mortgageCents)) {
      res.status(400).json({
        error: `Coverage fails the 35% buffer. ${usd(coverageCents)} of coverage is below the required ${usd(required)} (mortgage × 1.35).`,
      });
      return;
    }
    if (coverageCents > propertyValueCents) {
      res.status(400).json({
        error: `Coverage cannot exceed the property's estimated value of ${usd(propertyValueCents)}. ${usd(coverageCents)} was entered.`,
      });
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
          notes: "Re-checked at quote: stated coverage against mortgage × 1.35 and capped at property value.",
        },
      });
    }, TX_OPTIONS);

    res.json({ ok: true });
  }),
);
