import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import type { ListingStatus } from "@prisma/client";
import { prisma, TX_OPTIONS } from "../lib/db.js";
import { requireAuth, requireKyc, requireRole, wrap } from "../middleware/auth.js";
import { DISCLOSURE_VERSION, DISCLOSURE_TEXT, assertSafeCopy } from "../lib/copy.js";
import { canCollectMoney, flags } from "../lib/flags.js";
import { platformFeeCents, usd } from "../lib/money.js";
import { putObject, safeKey } from "../lib/storage.js";
import { radiusKmForPeril } from "../lib/labels.js";
import { notifyListingParties } from "../lib/notify.js";

export const listingsRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12_000_000 } });

const contributeSchema = z.object({
  amount: z.coerce.number().positive("Enter a contribution amount."),
  asOwner: z.union([z.boolean(), z.string()]).optional().default(false),
});

const listingInclude = {
  property: { include: { mortgage: true, owner: { select: { id: true, name: true, email: true } } } },
  quote: { include: { quoteRequest: { include: { carrierProduct: true } } } },
  contributions: { include: { user: { select: { id: true, name: true, email: true } } } },
  ledger: true,
  policy: true,
  documents: true,
} as const;

listingsRouter.get(
  "/disclosure",
  wrap(async (_req, res) => {
    assertSafeCopy(DISCLOSURE_TEXT);
    res.json({ version: DISCLOSURE_VERSION, text: DISCLOSURE_TEXT });
  }),
);

listingsRouter.post(
  "/disclosure/accept",
  requireAuth,
  wrap(async (req, res) => {
    await prisma.disclosureAcceptance.create({
      data: {
        userId: req.user!.id,
        listingId: null,
        version: DISCLOSURE_VERSION,
      },
    });
    res.json({ ok: true, version: DISCLOSURE_VERSION });
  }),
);

listingsRouter.get(
  "/map",
  requireAuth,
  wrap(async (_req, res) => {
    const listings = await prisma.listing.findMany({
      where: { status: { in: ["LIVE", "FULLY_FUNDED", "ACTIVE", "TOPUP_WINDOW"] } },
      include: listingInclude,
      orderBy: { createdAt: "desc" },
    });
    res.json({ listings });
  }),
);

listingsRouter.get(
  "/",
  requireAuth,
  wrap(async (req, res) => {
    const role = req.user!.role;
    const listings = await prisma.listing.findMany({
      where:
        role === "OWNER"
          ? { property: { ownerId: req.user!.id } }
          : role === "FUNDER"
            ? {
                OR: [
                  {
                    status: {
                      in: ["LIVE", "FULLY_FUNDED", "ACTIVE", "TOPUP_WINDOW", "AWAITING_LENDER"],
                    },
                  },
                  { contributions: { some: { userId: req.user!.id } } },
                ],
              }
            : role === "CARRIER" && req.user!.carrierId
              ? { quote: { quoteRequest: { carrierProduct: { carrierId: req.user!.carrierId } } } }
              : {},
      include: listingInclude,
      orderBy: { createdAt: "desc" },
    });
    res.json({ listings });
  }),
);

const PUBLIC_LISTING_STATUSES = ["LIVE", "FULLY_FUNDED", "ACTIVE", "TOPUP_WINDOW", "AWAITING_LENDER"];

listingsRouter.get(
  "/:id",
  requireAuth,
  wrap(async (req, res) => {
    const listing = await prisma.listing.findUnique({
      where: { id: req.params.id as string },
      include: listingInclude,
    });
    if (!listing) {
      res.status(404).json({ error: "Listing not found." });
      return;
    }
    const role = req.user!.role;
    const allowed =
      role === "ADMIN" ||
      listing.property.ownerId === req.user!.id ||
      (role === "CARRIER" &&
        listing.quote.quoteRequest.carrierProduct.carrierId === req.user!.carrierId) ||
      (role === "FUNDER" &&
        (PUBLIC_LISTING_STATUSES.includes(listing.status) ||
          listing.contributions.some((c) => c.userId === req.user!.id)));
    if (!allowed) {
      res.status(403).json({ error: "Not allowed." });
      return;
    }
    res.json({ listing });
  }),
);

listingsRouter.post(
  "/:id/disclosure",
  requireAuth,
  wrap(async (req, res) => {
    await prisma.disclosureAcceptance.create({
      data: {
        userId: req.user!.id,
        listingId: req.params.id as string,
        version: DISCLOSURE_VERSION,
      },
    });
    res.json({ ok: true, version: DISCLOSURE_VERSION });
  }),
);

listingsRouter.post(
  "/:id/contribute",
  requireAuth,
  requireKyc,
  wrap(async (req, res) => {
    if (!canCollectMoney()) {
      res.status(400).json({ error: "Collections are flagged off." });
      return;
    }
    if (flags.paymentsEnabled) {
      res.status(400).json({ error: "Live payments are off in this mock build." });
      return;
    }

    const listingId = req.params.id as string;
    const parsedBody = contributeSchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ error: parsedBody.error.issues[0]?.message ?? "Invalid request." });
      return;
    }
    const amountCents = Math.round(parsedBody.data.amount * 100);
    const asOwner = parsedBody.data.asOwner === true || parsedBody.data.asOwner === "on";

    const listing = await prisma.listing.findUnique({
      where: { id: listingId },
      include: {
        property: { include: { mortgage: true } },
        contributions: { where: { status: "SUCCEEDED" }, select: { userId: true } },
        quote: { include: { quoteRequest: { include: { carrierProduct: { select: { carrierId: true } } } } } },
      },
    });
    if (!listing) {
      res.status(404).json({ error: "Listing not found." });
      return;
    }

    const remaining = listing.premiumTargetCents - listing.fundedCents;
    if (amountCents > remaining) {
      res.status(400).json({ error: "That amount exceeds the remaining premium." });
      return;
    }

    if (asOwner) {
      if (listing.property.ownerId !== req.user!.id && req.user!.role !== "ADMIN") {
        res.status(403).json({ error: "Only the named owner can fund the 15% minimum." });
        return;
      }
      if (
        listing.status !== "AWAITING_OWNER_FUNDS" &&
        listing.status !== "TOPUP_WINDOW" &&
        listing.status !== "LIVE"
      ) {
        res.status(400).json({ error: "Owner funds are not being accepted on this listing." });
        return;
      }
      const minimum = Math.ceil(listing.premiumTargetCents * 0.15);
      const nextOwner = listing.ownerContributionCents + amountCents;
      if (
        listing.status === "AWAITING_OWNER_FUNDS" &&
        nextOwner < minimum &&
        amountCents < remaining
      ) {
        res.status(400).json({
          error: "Owner must reach at least 15% of premium before the listing goes live.",
        });
        return;
      }
    } else {
      if (req.user!.role !== "FUNDER" && req.user!.role !== "ADMIN") {
        res.status(403).json({ error: "Corporate program accounts contribute here." });
        return;
      }
      if (!flags.contributionsPublic && req.user!.role === "FUNDER") {
        const membership = await prisma.membership.findFirst({
          where: { userId: req.user!.id, organization: { approved: true } },
        });
        if (!membership) {
          res.status(403).json({ error: "Your organization is not yet approved for the closed pilot." });
          return;
        }
      }
      const disclosure = await prisma.disclosureAcceptance.findFirst({
        where: { userId: req.user!.id, version: DISCLOSURE_VERSION },
      });
      if (!disclosure) {
        res.status(400).json({ error: "Accept the risk disclosure before contributing." });
        return;
      }
      if (listing.status !== "LIVE") {
        res.status(400).json({ error: "This listing is not open for contributions." });
        return;
      }
    }

    if (listing.expiresAt && listing.expiresAt < new Date() && listing.status === "LIVE") {
      res.status(400).json({ error: "This listing has reached its deadline." });
      return;
    }

    const membership = await prisma.membership.findFirst({
      where: { userId: req.user!.id },
    });

    const nextFunded = listing.fundedCents + amountCents;
    const nextOwner = asOwner
      ? listing.ownerContributionCents + amountCents
      : listing.ownerContributionCents;
    const fullyFunded = nextFunded >= listing.premiumTargetCents;
    const minOwner = Math.ceil(listing.premiumTargetCents * 0.15);

    let nextStatus: ListingStatus = listing.status;
    if (asOwner && nextOwner >= minOwner && listing.status === "AWAITING_OWNER_FUNDS") {
      nextStatus = "LIVE";
    }
    // Owners can keep contributing beyond the 15% minimum while a listing is
    // Live (or during a top-up window) — if that contribution is the one that
    // completes funding, it must flip straight to FULLY_FUNDED regardless of
    // whether it was the owner or a funder who closed the gap.
    if (fullyFunded && (nextStatus === "LIVE" || nextStatus === "TOPUP_WINDOW")) {
      nextStatus = "FULLY_FUNDED";
    }

    const justWentLive = nextStatus === "LIVE" && listing.status !== "LIVE";
    const hasMortgage = Boolean(listing.property.mortgage);

    await prisma.$transaction(async (tx) => {
      await tx.contribution.create({
        data: {
          listingId,
          userId: req.user!.id,
          organizationId: asOwner ? null : membership?.organizationId,
          amountCents,
          status: "SUCCEEDED",
        },
      });
      await tx.escrowLedger.create({
        data: {
          listingId,
          type: asOwner ? "OWNER_PREMIUM" : "FUNDER_PREMIUM",
          amountCents,
          partyUserId: req.user!.id,
          note: "simulated collection",
        },
      });
      await tx.listing.update({
        where: { id: listingId },
        data: {
          fundedCents: nextFunded,
          ownerContributionCents: nextOwner,
          status: nextStatus,
          liveAt: nextStatus === "LIVE" && !listing.liveAt ? new Date() : listing.liveAt,
          ...(justWentLive && hasMortgage ? { lenderNamedLossPayee: true } : {}),
        },
      });
      // Lender is automatically named loss payee and notified the moment a
      // listing goes live, per BRD §2.3/§8.2 — not a manual admin step.
      if (justWentLive && hasMortgage) {
        await tx.mortgage.update({
          where: { propertyId: listing.propertyId },
          data: { notifiedAt: new Date() },
        });
      }
    }, TX_OPTIONS);

    // listing.status can never already be FULLY_FUNDED here — every path above
    // (owner and funder alike) rejects a contribution unless the listing was
    // AWAITING_OWNER_FUNDS, TOPUP_WINDOW, or LIVE, so nextStatus === FULLY_FUNDED
    // always means this contribution is the one that just completed funding.
    if (nextStatus === "FULLY_FUNDED") {
      const contributorIds = new Set(listing.contributions.map((c) => c.userId));
      contributorIds.add(req.user!.id);
      await notifyListingParties({
        listingId,
        ownerId: listing.property.ownerId,
        contributorUserIds: Array.from(contributorIds),
        carrierId: listing.quote.quoteRequest.carrierProduct.carrierId,
        kind: "LISTING_FULLY_FUNDED",
        title: "Listing fully funded",
        body: `${listing.property.address}, ${listing.property.city} has reached 100% of its premium target and is ready to bind.`,
      });
    }

    res.json({ ok: true, fullyFunded, status: nextStatus });
  }),
);

const CANCELLABLE_STATUSES = ["AWAITING_OWNER_FUNDS", "LIVE", "TOPUP_WINDOW"] as const;

listingsRouter.post(
  "/:id/cancel",
  requireAuth,
  wrap(async (req, res) => {
    const listingId = req.params.id as string;
    const listing = await prisma.listing.findUnique({
      where: { id: listingId },
      include: { property: true },
    });
    if (!listing) {
      res.status(404).json({ error: "Listing not found." });
      return;
    }
    if (listing.property.ownerId !== req.user!.id && req.user!.role !== "ADMIN") {
      res.status(403).json({ error: "Only the property owner can cancel this listing." });
      return;
    }
    if (!CANCELLABLE_STATUSES.includes(listing.status as (typeof CANCELLABLE_STATUSES)[number])) {
      res.status(400).json({
        error: "This listing can no longer be cancelled — it's already fully funded or bound.",
      });
      return;
    }
    await refundListing(listingId, "Cancelled by property owner before full funding.");
    res.json({ ok: true });
  }),
);

listingsRouter.post(
  "/:id/lender",
  requireAuth,
  requireRole("ADMIN", "CARRIER"),
  wrap(async (req, res) => {
    const listing = await prisma.listing.findUnique({
      where: { id: req.params.id as string },
      include: { property: { include: { mortgage: true } } },
    });
    if (!listing) {
      res.status(404).json({ error: "Listing not found." });
      return;
    }
    await prisma.$transaction(async (tx) => {
      await tx.listing.update({
        where: { id: listing.id },
        data: {
          lenderNamedLossPayee: true,
          status: listing.status === "AWAITING_LENDER" ? "FULLY_FUNDED" : listing.status,
        },
      });
      if (listing.property.mortgage) {
        await tx.mortgage.update({
          where: { propertyId: listing.propertyId },
          data: { notifiedAt: new Date() },
        });
      }
    }, TX_OPTIONS);
    res.json({ ok: true });
  }),
);

listingsRouter.post(
  "/:id/bind",
  requireAuth,
  requireRole("ADMIN", "CARRIER"),
  wrap(async (req, res) => {
    const listing = await prisma.listing.findUnique({
      where: { id: req.params.id as string },
      include: {
        property: { include: { mortgage: true, owner: true } },
        quote: { include: { quoteRequest: { include: { carrierProduct: true } } } },
        contributions: { where: { status: "SUCCEEDED" }, select: { userId: true } },
      },
    });
    if (!listing) {
      res.status(404).json({ error: "Listing not found." });
      return;
    }
    if (listing.status !== "FULLY_FUNDED" && listing.status !== "AWAITING_LENDER") {
      res.status(400).json({ error: "Listing must be fully funded before bind." });
      return;
    }
    if (!listing.quote.validUntil || listing.quote.validUntil < new Date()) {
      res.status(400).json({ error: "Quote is no longer valid." });
      return;
    }
    if (listing.fundedCents < listing.premiumTargetCents) {
      res.status(400).json({ error: "Premium is not fully funded." });
      return;
    }
    if (!listing.lenderNamedLossPayee && listing.property.mortgage) {
      await prisma.listing.update({
        where: { id: listing.id },
        data: { status: "AWAITING_LENDER" },
      });
      res.status(400).json({ error: "Name the lender as loss payee before bind." });
      return;
    }
    if (flags.payoutsAutomated) {
      res.status(400).json({
        error: "Automated remittance is flagged off until the finance partner is live.",
      });
      return;
    }

    const fee = platformFeeCents(listing.premiumTargetCents);
    const remittance = listing.premiumTargetCents - fee;
    const carrierId = listing.quote.quoteRequest.carrierProduct.carrierId;
    const policyNumber = `FS-${listing.property.state}-${Date.now().toString().slice(-8)}`;
    const instruction = [
      "FiSure remittance instruction — not a carrier API call",
      `Listing: ${listing.id}`,
      `Named insured: ${listing.property.owner.email}`,
      `Gross funded premium: ${usd(listing.premiumTargetCents)}`,
      `Platform fee (full premium basis): ${usd(fee)}`,
      `Net to premium-finance partner / carrier: ${usd(remittance)}`,
      `Loss payee: ${listing.property.mortgage?.lenderName ?? "none"}`,
    ].join("\n");

    const instructionKey = safeKey(["listings", listing.id, "remittance.txt"]);
    await putObject({
      key: instructionKey,
      body: Buffer.from(instruction),
      mimeType: "text/plain",
    });

    let boundPolicyId = "";
    await prisma.$transaction(async (tx) => {
      await tx.escrowLedger.create({
        data: {
          listingId: listing.id,
          type: "PLATFORM_FEE",
          amountCents: fee,
          note: "Tiered commission on full funded premium",
        },
      });
      await tx.escrowLedger.create({
        data: {
          listingId: listing.id,
          type: "CARRIER_REMITTANCE",
          amountCents: remittance,
          note: "Instruction to premium-finance partner",
        },
      });
      await tx.document.create({
        data: {
          kind: "REMITTANCE",
          filename: "remittance-instruction.txt",
          storageKey: instructionKey,
          mimeType: "text/plain",
          listingId: listing.id,
          uploadedById: req.user!.id,
        },
      });
      const policy = await tx.policy.create({
        data: {
          listingId: listing.id,
          carrierId,
          policyNumber,
          lenderNamedLossPayee: listing.lenderNamedLossPayee,
        },
      });
      boundPolicyId = policy.id;
      await tx.triggerWatch.create({
        data: {
          policyId: policy.id,
          peril: listing.property.peril,
          lat: listing.property.lat,
          lng: listing.property.lng,
          radiusKm: radiusKmForPeril(listing.property.peril),
        },
      });
      await tx.listing.update({
        where: { id: listing.id },
        data: { status: "ACTIVE" },
      });
    }, TX_OPTIONS);

    await notifyListingParties({
      listingId: listing.id,
      ownerId: listing.property.ownerId,
      contributorUserIds: listing.contributions.map((c) => c.userId),
      carrierId,
      kind: "POLICY_BOUND",
      title: "Policy bound",
      body: `Policy ${policyNumber} is now active for ${listing.property.address}, ${listing.property.city}.`,
      policyId: boundPolicyId,
    });

    res.json({ ok: true, policyNumber });
  }),
);

listingsRouter.post(
  "/:id/policy-pdf",
  requireAuth,
  requireRole("CARRIER", "ADMIN"),
  upload.single("policy"),
  wrap(async (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "Upload the executed policy PDF." });
      return;
    }
    const listing = await prisma.listing.findUnique({
      where: { id: req.params.id as string },
      include: { policy: true },
    });
    if (!listing?.policy) {
      res.status(400).json({ error: "Bind the policy before uploading documents." });
      return;
    }
    const key = safeKey(["policies", listing.policy.id, file.originalname]);
    await putObject({
      key,
      body: file.buffer,
      mimeType: file.mimetype || "application/pdf",
    });
    await prisma.document.create({
      data: {
        kind: "POLICY",
        filename: file.originalname,
        storageKey: key,
        mimeType: file.mimetype || "application/pdf",
        listingId: listing.id,
        policyId: listing.policy.id,
        uploadedById: req.user!.id,
      },
    });
    res.json({ ok: true });
  }),
);

export async function refundListing(listingId: string, reason: string) {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    include: { contributions: true },
  });
  if (!listing) return;
  if (listing.status === "ACTIVE" || listing.status === "BINDING") return;

  await prisma.$transaction(async (tx) => {
    for (const contribution of listing.contributions) {
      if (contribution.status !== "SUCCEEDED") continue;
      await tx.contribution.update({
        where: { id: contribution.id },
        data: { status: "REFUNDED" },
      });
      await tx.escrowLedger.create({
        data: {
          listingId,
          type: "REFUND",
          amountCents: -contribution.amountCents,
          stripePaymentIntentId: contribution.stripePaymentIntentId,
          partyUserId: contribution.userId,
          note: reason,
        },
      });
    }
    await tx.listing.update({
      where: { id: listingId },
      data: {
        status: listing.status === "TOPUP_WINDOW" ? "TOPUP_LAPSED" : "EXPIRED",
        fundedCents: 0,
      },
    });
  }, TX_OPTIONS);
}

export async function expireOrTopUpListings() {
  const now = new Date();
  const liveExpired = await prisma.listing.findMany({
    where: { status: "LIVE", expiresAt: { lte: now } },
  });
  for (const listing of liveExpired) {
    const topUpEndsAt = new Date(now);
    topUpEndsAt.setDate(topUpEndsAt.getDate() + 7);
    await prisma.listing.update({
      where: { id: listing.id },
      data: { status: "TOPUP_WINDOW", topUpEndsAt },
    });
  }

  const lapsed = await prisma.listing.findMany({
    where: { status: "TOPUP_WINDOW", topUpEndsAt: { lte: now } },
  });
  for (const listing of lapsed) {
    await refundListing(listing.id, "Top-up window lapsed. Full refund. No fee.");
  }
  return { expired: liveExpired.length, lapsed: lapsed.length };
}
