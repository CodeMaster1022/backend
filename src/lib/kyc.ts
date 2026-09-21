import { prisma, TX_OPTIONS } from "./db.js";
import { sendNotificationEmails } from "./notify.js";

const REFUNDABLE_STATUSES = ["ACTIVE", "BINDING"] as const;
const KYC_FAILED_TITLE = "Identity check failed";
const KYC_FAILED_BODY =
  "Per platform policy, any escrowed contributions on not-yet-active listings were refunded in full.";

export async function failKycAndRefund(userId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { kycStatus: "FAILED" } });
    await tx.notification.create({
      data: {
        userId,
        kind: "KYC_FAILED",
        title: KYC_FAILED_TITLE,
        body: KYC_FAILED_BODY,
      },
    });

    const contributions = await tx.contribution.findMany({
      where: {
        userId,
        status: "SUCCEEDED",
        listing: { status: { notIn: [...REFUNDABLE_STATUSES] } },
      },
      include: { listing: { include: { property: true } } },
    });

    for (const contribution of contributions) {
      const listing = contribution.listing;
      const isOwnerShare = listing.property.ownerId === userId;
      const minOwner = Math.ceil(listing.premiumTargetCents * 0.15);

      await tx.contribution.update({
        where: { id: contribution.id },
        data: { status: "REFUNDED" },
      });
      await tx.escrowLedger.create({
        data: {
          listingId: listing.id,
          type: "REFUND",
          amountCents: -contribution.amountCents,
          stripePaymentIntentId: contribution.stripePaymentIntentId,
          partyUserId: userId,
          note: "KYC/AML failure. Immediate disqualification, full refund.",
        },
      });

      const nextFunded = Math.max(0, listing.fundedCents - contribution.amountCents);
      const nextOwner = isOwnerShare
        ? Math.max(0, listing.ownerContributionCents - contribution.amountCents)
        : listing.ownerContributionCents;

      // Derive the status from the post-refund numbers for every pre-active
      // status, rather than special-casing LIVE and FULLY_FUNDED. Refunding
      // against AWAITING_LENDER or TOPUP_WINDOW used to drop funding below
      // target while leaving the status untouched, which left bind permanently
      // rejecting the listing with no way back.
      const RECALCULABLE = ["AWAITING_OWNER_FUNDS", "LIVE", "TOPUP_WINDOW", "FULLY_FUNDED", "AWAITING_LENDER"];
      let nextStatus = listing.status;
      if (RECALCULABLE.includes(listing.status)) {
        if (nextOwner < minOwner) {
          nextStatus = "AWAITING_OWNER_FUNDS";
        } else if (nextFunded >= listing.premiumTargetCents) {
          // Still fully funded after the refund — keep it where it was so a
          // listing already waiting on the lender isn't bounced backwards.
          nextStatus = listing.status === "AWAITING_LENDER" ? "AWAITING_LENDER" : "FULLY_FUNDED";
        } else {
          nextStatus = listing.status === "TOPUP_WINDOW" ? "TOPUP_WINDOW" : "LIVE";
        }
      }

      await tx.listing.update({
        where: { id: listing.id },
        data: {
          fundedCents: nextFunded,
          ownerContributionCents: nextOwner,
          status: nextStatus,
        },
      });
    }
  }, TX_OPTIONS);
  await sendNotificationEmails([userId], KYC_FAILED_TITLE, KYC_FAILED_BODY);
}
