import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma, TX_OPTIONS } from "../lib/db.js";
import { requireAuth, requireKyc, requireRole, wrap } from "../middleware/auth.js";
import { DISCLOSURE_VERSION, DISCLOSURE_TEXT, assertSafeCopy } from "../lib/copy.js";
import { canCollectMoney, flags } from "../lib/flags.js";
import { platformFeeCents, usd } from "../lib/money.js";
import { putObject, safeKey } from "../lib/storage.js";
import { radiusKmForPeril } from "../lib/labels.js";
import { notifyListingParties } from "../lib/notify.js";
import { loadAndValidateContribution, finalizeContribution } from "../lib/contributions.js";
import { stripe } from "../lib/stripe.js";
import { isAllowedReturnUrl, firstAllowedOrigin } from "../lib/origins.js";
import { parsePagination, paginationMeta } from "../lib/pagination.js";

export const listingsRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12_000_000 } });

const contributeSchema = z.object({
  amount: z.coerce.number().positive("Enter a contribution amount."),
  asOwner: z.union([z.boolean(), z.string()]).optional().default(false),
  returnUrl: z.string().trim().optional(),
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
    const where: Prisma.ListingWhereInput =
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
            : {};

    // Paginate only when a caller explicitly asks for a page — /listings is
    // also called unpaginated by pages that need the complete set to
    // aggregate/group/filter client-side (commissions, portfolio, carrier
    // policies grouping), and must keep getting everything back.
    const paginate = req.query.page !== undefined;
    const { page, pageSize, skip, take } = parsePagination(req.query);
    const [listings, total] = await Promise.all([
      prisma.listing.findMany({
        where,
        include: listingInclude,
        orderBy: { createdAt: "desc" },
        ...(paginate ? { skip, take } : {}),
      }),
      paginate ? prisma.listing.count({ where }) : Promise.resolve(0),
    ]);
    res.json({ listings, ...(paginate ? paginationMeta(total, page, pageSize) : {}) });
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

    const listingId = req.params.id as string;
    const parsedBody = contributeSchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ error: parsedBody.error.issues[0]?.message ?? "Invalid request." });
      return;
    }
    const amountCents = Math.round(parsedBody.data.amount * 100);
    const asOwner = parsedBody.data.asOwner === true || parsedBody.data.asOwner === "on";

    const check = await loadAndValidateContribution({
      listingId,
      userId: req.user!.id,
      userRole: req.user!.role,
      amountCents,
      asOwner,
    });
    if (!check.ok) {
      res.status(400).json({ error: check.error });
      return;
    }
    const listing = check.listing;

    if (flags.paymentsEnabled) {
      if (!stripe) {
        res.status(500).json({ error: "Payments are enabled but Stripe is not configured." });
        return;
      }
      const returnUrl =
        parsedBody.data.returnUrl && isAllowedReturnUrl(parsedBody.data.returnUrl)
          ? parsedBody.data.returnUrl
          : `${firstAllowedOrigin()}/app`;
      const separator = returnUrl.includes("?") ? "&" : "?";
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: `Premium contribution — ${listing.property.address}, ${listing.property.city}`,
              },
              unit_amount: amountCents,
            },
            quantity: 1,
          },
        ],
        success_url: `${returnUrl}${separator}checkout=success`,
        cancel_url: `${returnUrl}${separator}checkout=cancelled`,
        client_reference_id: req.user!.id,
        metadata: {
          listingId,
          userId: req.user!.id,
          asOwner: String(asOwner),
        },
      });
      res.json({ checkoutUrl: session.url });
      return;
    }

    const result = await finalizeContribution({
      listingId,
      userId: req.user!.id,
      userRole: req.user!.role,
      amountCents,
      asOwner,
      stripePaymentIntentId: null,
      note: "simulated collection",
    });
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true, fullyFunded: result.fullyFunded, status: result.status });
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
      include: {
        property: { include: { mortgage: true } },
        quote: { include: { quoteRequest: { include: { carrierProduct: true } } } },
      },
    });
    if (!listing) {
      res.status(404).json({ error: "Listing not found." });
      return;
    }
    if (
      req.user!.role === "CARRIER" &&
      listing.quote.quoteRequest.carrierProduct.carrierId !== req.user!.carrierId
    ) {
      res.status(403).json({ error: "This listing is not in your book." });
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
    if (
      req.user!.role === "CARRIER" &&
      listing.quote.quoteRequest.carrierProduct.carrierId !== req.user!.carrierId
    ) {
      res.status(403).json({ error: "This listing is not in your book." });
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
      // Negative: both are outflows from escrow, same sign convention as REFUND.
      // Premium in (positive) minus fee + remittance out (negative) nets a bound
      // listing's ledger to exactly zero, which is what makes it a usable
      // trust-account balance.
      await tx.escrowLedger.create({
        data: {
          listingId: listing.id,
          type: "PLATFORM_FEE",
          amountCents: -fee,
          note: "Tiered commission on full funded premium",
        },
      });
      await tx.escrowLedger.create({
        data: {
          listingId: listing.id,
          type: "CARRIER_REMITTANCE",
          amountCents: -remittance,
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
    if (req.user!.role === "CARRIER" && listing.policy.carrierId !== req.user!.carrierId) {
      res.status(403).json({ error: "This policy is not in your book." });
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
        ownerContributionCents: 0,
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

  // Fully funded but never bound before the quote expired: bind is permanently
  // blocked from here and neither cancel nor the sweeps above touch these
  // statuses, so without this pass the contributors' money is trapped forever.
  const staleQuote = await prisma.listing.findMany({
    where: {
      status: { in: ["FULLY_FUNDED", "AWAITING_LENDER"] },
      quote: { validUntil: { lte: now } },
    },
  });
  for (const listing of staleQuote) {
    await refundListing(listing.id, "Quote expired before bind. Full refund. No fee.");
  }

  return { expired: liveExpired.length, lapsed: lapsed.length, staleQuote: staleQuote.length };
}
