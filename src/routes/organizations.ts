import { Router } from "express";
import { prisma } from "../lib/db.js";
import { requireAuth, wrap } from "../middleware/auth.js";
import { usd } from "../lib/money.js";
import { PERIL_LABEL } from "../lib/labels.js";

export const organizationsRouter = Router();

async function loadImpact(userId: string) {
  const membership = await prisma.membership.findFirst({
    where: { userId },
    include: { organization: true },
  });
  if (!membership) return null;

  const contributions = await prisma.contribution.findMany({
    where: { organizationId: membership.organizationId, status: "SUCCEEDED" },
    include: { listing: { include: { property: true } } },
  });

  const totalContributedCents = contributions.reduce((sum, c) => sum + c.amountCents, 0);
  const listingIds = new Set(contributions.map((c) => c.listingId));
  const communities = new Set(
    contributions.map((c) => `${c.listing.property.city}, ${c.listing.property.state}`),
  );
  const byPeril: Record<string, number> = {};
  for (const c of contributions) {
    byPeril[c.listing.property.peril] = (byPeril[c.listing.property.peril] ?? 0) + c.amountCents;
  }

  const byListing = new Map<
    string,
    { listingId: string; address: string; city: string; state: string; peril: string; status: string; amountCents: number }
  >();
  for (const c of contributions) {
    const key = c.listingId;
    const existing = byListing.get(key);
    if (existing) {
      existing.amountCents += c.amountCents;
    } else {
      byListing.set(key, {
        listingId: c.listingId,
        address: c.listing.property.address,
        city: c.listing.property.city,
        state: c.listing.property.state,
        peril: c.listing.property.peril,
        status: c.listing.status,
        amountCents: c.amountCents,
      });
    }
  }

  return {
    organization: { id: membership.organization.id, name: membership.organization.name },
    totalContributedCents,
    propertiesSupported: listingIds.size,
    communitiesCovered: communities.size,
    byPeril,
    listings: Array.from(byListing.values()).sort((a, b) => b.amountCents - a.amountCents),
  };
}

organizationsRouter.get(
  "/me/impact",
  requireAuth,
  wrap(async (req, res) => {
    const impact = await loadImpact(req.user!.id);
    if (!impact) {
      res.status(404).json({ error: "No corporate organization linked to this account." });
      return;
    }
    res.json(impact);
  }),
);

organizationsRouter.get(
  "/me/impact/report",
  requireAuth,
  wrap(async (req, res) => {
    const impact = await loadImpact(req.user!.id);
    if (!impact) {
      res.status(404).json({ error: "No corporate organization linked to this account." });
      return;
    }

    const lines = [
      "FiSure Community Impact Report",
      `Organization: ${impact.organization.name}`,
      `Generated: ${new Date().toISOString()}`,
      "",
      `Total premium support contributed: ${usd(impact.totalContributedCents)}`,
      `Properties supported: ${impact.propertiesSupported}`,
      `Communities covered: ${impact.communitiesCovered}`,
      "",
      "Breakdown by peril:",
      ...Object.entries(impact.byPeril).map(
        ([peril, cents]) => `  ${PERIL_LABEL[peril] ?? peril}: ${usd(cents)}`,
      ),
      "",
      "Listings supported:",
      ...impact.listings.map(
        (l) =>
          `  - ${l.address}, ${l.city}, ${l.state} — ${PERIL_LABEL[l.peril] ?? l.peril} — contributed ${usd(l.amountCents)} — status ${l.status}`,
      ),
      "",
      "This report reflects community-impact contributions, not investment returns.",
      "FiSure is a marketplace operator and is not the insurer, underwriter, or guarantor of any payout.",
    ];

    const body = lines.join("\n");
    res.setHeader("Content-Type", "text/plain");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="fisure-impact-report-${new Date().toISOString().slice(0, 10)}.txt"`,
    );
    res.send(body);
  }),
);
