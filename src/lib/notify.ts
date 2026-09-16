import type { NotificationKind } from "@prisma/client";
import { prisma } from "./db.js";
import { sendEmail } from "./email.js";

/** Best-effort email fan-out for a set of already-notified users. Never
 * throws — called after the in-app Notification rows are safely persisted,
 * so an email provider hiccup can't roll back or block the underlying
 * business operation. */
export async function sendNotificationEmails(userIds: Iterable<string>, subject: string, text: string) {
  const ids = Array.from(new Set(userIds));
  if (ids.length === 0) return;
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { email: true } });
  await Promise.all(users.map((u) => sendEmail({ to: u.email, subject, text })));
}

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
  await sendNotificationEmails(recipientIds, params.title, params.body);
}

export async function notifyCarrierNewQuoteRequest(params: {
  carrierId: string;
  title: string;
  body: string;
}) {
  const carrierUsers = await prisma.user.findMany({
    where: { carrierId: params.carrierId },
    select: { id: true },
  });
  const admins = await prisma.user.findMany({ where: { role: "ADMIN" }, select: { id: true } });
  const recipientIds = new Set<string>([...carrierUsers.map((u) => u.id), ...admins.map((u) => u.id)]);

  await prisma.notification.createMany({
    data: Array.from(recipientIds).map((userId) => ({
      userId,
      kind: "QUOTE_REQUEST_RECEIVED",
      title: params.title,
      body: params.body,
    })),
  });
  await sendNotificationEmails(recipientIds, params.title, params.body);
}
