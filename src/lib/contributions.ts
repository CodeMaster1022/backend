import type { ListingStatus } from "@prisma/client";
import { prisma, TX_OPTIONS } from "./db.js";
import { flags } from "./flags.js";
import { DISCLOSURE_VERSION } from "./copy.js";
import { notifyListingParties } from "./notify.js";

const listingIncludeForContribution = {
  property: { include: { mortgage: true } },
  contributions: { where: { status: "SUCCEEDED" as const }, select: { userId: true } },
  quote: { include: { quoteRequest: { include: { carrierProduct: { select: { carrierId: true } } } } } },
} as const;

/**
 * Every check here must be re-run at finalize time (not just before sending a
 * contributor to Stripe Checkout), since listing state can change in the
 * minutes between session creation and payment confirmation — e.g. someone
 * else's contribution filling the remaining premium first. That's what keeps
 * this safe against races, not just against a single request.
 */
export async function loadAndValidateContribution(params: {
  listingId: string;
  userId: string;
  userRole: string;
  amountCents: number;
  asOwner: boolean;
}) {
  const listing = await prisma.listing.findUnique({
    where: { id: params.listingId },
    include: listingIncludeForContribution,
  });
  if (!listing) {
    return { ok: false as const, error: "Listing not found." };
  }

  const remaining = listing.premiumTargetCents - listing.fundedCents;
  if (params.amountCents > remaining) {
    return { ok: false as const, error: "That amount exceeds the remaining premium." };
  }

  if (params.asOwner) {
    if (listing.property.ownerId !== params.userId && params.userRole !== "ADMIN") {
      return { ok: false as const, error: "Only the named owner can fund the 15% minimum." };
    }
    if (
      listing.status !== "AWAITING_OWNER_FUNDS" &&
      listing.status !== "TOPUP_WINDOW" &&
      listing.status !== "LIVE"
    ) {
      return { ok: false as const, error: "Owner funds are not being accepted on this listing." };
    }
    const minimum = Math.ceil(listing.premiumTargetCents * 0.15);
    const nextOwner = listing.ownerContributionCents + params.amountCents;
    if (
      listing.status === "AWAITING_OWNER_FUNDS" &&
      nextOwner < minimum &&
      params.amountCents < remaining
    ) {
      return {
        ok: false as const,
        error: "Owner must reach at least 15% of premium before the listing goes live.",
      };
    }
  } else {
    if (params.userRole !== "FUNDER" && params.userRole !== "ADMIN") {
      return { ok: false as const, error: "Corporate program accounts contribute here." };
    }
    if (!flags.contributionsPublic && params.userRole === "FUNDER") {
      const membership = await prisma.membership.findFirst({
        where: { userId: params.userId, organization: { approved: true } },
      });
      if (!membership) {
        return { ok: false as const, error: "Your organization is not yet approved for the closed pilot." };
      }
    }
    const disclosure = await prisma.disclosureAcceptance.findFirst({
      where: { userId: params.userId, version: DISCLOSURE_VERSION },
    });
    if (!disclosure) {
      return { ok: false as const, error: "Accept the risk disclosure before contributing." };
    }
    if (listing.status !== "LIVE") {
      return { ok: false as const, error: "This listing is not open for contributions." };
    }
  }

  if (listing.expiresAt && listing.expiresAt < new Date() && listing.status === "LIVE") {
    return { ok: false as const, error: "This listing has reached its deadline." };
  }

  return { ok: true as const, listing };
}

export async function finalizeContribution(params: {
  listingId: string;
  userId: string;
  userRole: string;
  amountCents: number;
  asOwner: boolean;
  stripePaymentIntentId: string | null;
  note: string;
}) {
  const check = await loadAndValidateContribution(params);
  if (!check.ok) return check;
  const listing = check.listing;
  const listingId = params.listingId;

  const membership = params.asOwner
    ? null
    : await prisma.membership.findFirst({ where: { userId: params.userId } });

  const nextFunded = listing.fundedCents + params.amountCents;
  const nextOwner = params.asOwner
    ? listing.ownerContributionCents + params.amountCents
    : listing.ownerContributionCents;
  const fullyFunded = nextFunded >= listing.premiumTargetCents;
  const minOwner = Math.ceil(listing.premiumTargetCents * 0.15);

  let nextStatus: ListingStatus = listing.status;
  if (params.asOwner && nextOwner >= minOwner && listing.status === "AWAITING_OWNER_FUNDS") {
    nextStatus = "LIVE";
  }
  if (fullyFunded && (nextStatus === "LIVE" || nextStatus === "TOPUP_WINDOW")) {
    nextStatus = "FULLY_FUNDED";
  }

  const justWentLive = nextStatus === "LIVE" && listing.status !== "LIVE";
  const hasMortgage = Boolean(listing.property.mortgage);

  await prisma.$transaction(async (tx) => {
    await tx.contribution.create({
      data: {
        listingId,
        userId: params.userId,
        organizationId: params.asOwner ? null : membership?.organizationId,
        amountCents: params.amountCents,
        status: "SUCCEEDED",
        stripePaymentIntentId: params.stripePaymentIntentId,
      },
    });
    await tx.escrowLedger.create({
      data: {
        listingId,
        type: params.asOwner ? "OWNER_PREMIUM" : "FUNDER_PREMIUM",
        amountCents: params.amountCents,
        partyUserId: params.userId,
        stripePaymentIntentId: params.stripePaymentIntentId,
        note: params.note,
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
  // rejects a contribution unless the listing was AWAITING_OWNER_FUNDS,
  // TOPUP_WINDOW, or LIVE, so nextStatus === FULLY_FUNDED always means this
  // contribution is the one that just completed funding.
  if (nextStatus === "FULLY_FUNDED") {
    const contributorIds = new Set(listing.contributions.map((c) => c.userId));
    contributorIds.add(params.userId);
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

  return { ok: true as const, fullyFunded, status: nextStatus };
}
