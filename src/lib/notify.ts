import type { NotificationKind } from "@prisma/client";
import { prisma } from "./db.js";

export async function notifyListingParties(params: {
  listingId: string;
  ownerId: string;
  contributorUserIds: string[];
  carrierId: string | null;
  kind: NotificationKind;
  title: string;
  body: string;
  policyId?: string;
}) {
  const recipientIds = new Set<string>([params.ownerId, ...params.contributorUserIds]);

  if (params.carrierId) {
    const carrierUsers = await prisma.user.findMany({
      where: { carrierId: params.carrierId },
      select: { id: true },
    });
    for (const u of carrierUsers) recipientIds.add(u.id);
  }
  const admins = await prisma.user.findMany({ where: { role: "ADMIN" }, select: { id: true } });
  for (const a of admins) recipientIds.add(a.id);

  await prisma.notification.createMany({
    data: Array.from(recipientIds).map((userId) => ({
      userId,
      kind: params.kind,
      title: params.title,
      body: params.body,
      listingId: params.listingId,
      policyId: params.policyId,
    })),
  });
}
