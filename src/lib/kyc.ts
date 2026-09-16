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

      let nextStatus = listing.status;
      if (listing.status === "LIVE" && nextOwner < minOwner) {
        nextStatus = "AWAITING_OWNER_FUNDS";
      }
      if (listing.status === "FULLY_FUNDED" && nextFunded < listing.premiumTargetCents) {
        nextStatus = nextOwner >= minOwner ? "LIVE" : "AWAITING_OWNER_FUNDS";
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
