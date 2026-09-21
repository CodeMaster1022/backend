import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth, requireRole, wrap } from "../middleware/auth.js";
import { flags } from "../lib/flags.js";
import { bps, usd, waterfall } from "../lib/money.js";
import { putObject, safeKey } from "../lib/storage.js";

export const payoutsRouter = Router();

const previewSchema = z.object({
  gross: z.coerce.number().min(0).default(0),
  mortgage: z.coerce.number().min(0).default(0),
  ownerBps: z.coerce.number().min(0).max(10_000).default(0),
});

// No `mortgage` here on purpose: it's read from the property's real mortgage
// balance server-side. It used to be operator-typed, so a decimal typo silently
// redirected the whole waterfall to the lender.
const createPayoutSchema = z.object({
  policyId: z.string().trim().min(1, "Policy is required."),
  gross: z.coerce.number().positive("Enter gross proceeds."),
});

payoutsRouter.get(
  "/policies",
  requireAuth,
  requireRole("ADMIN"),
  wrap(async (_req, res) => {
    const policies = await prisma.policy.findMany({
      include: {
        listing: {
          include: {
            property: { include: { mortgage: true, owner: true } },
            contributions: { where: { status: "SUCCEEDED" }, include: { user: true } },
            quote: true,
          },
        },
        payouts: { include: { lines: true } },
      },
      orderBy: { boundAt: "desc" },
    });
    res.json({ policies });
  }),
);

payoutsRouter.post(
  "/preview",
  requireAuth,
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    const parsed = previewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request." });
      return;
    }
    const split = waterfall({
      grossCents: Math.round(parsed.data.gross * 100),
      mortgageCents: Math.round(parsed.data.mortgage * 100),
      ownerContributionBps: parsed.data.ownerBps,
    });
    res.json({ split });
  }),
);

payoutsRouter.post(
  "/",
  requireAuth,
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    if (flags.payoutsAutomated) {
      res.status(400).json({ error: "Automated payouts are flagged. Keep this path manual." });
      return;
    }
    const parsed = createPayoutSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request." });
      return;
    }
    const policyId = parsed.data.policyId;
    const grossCents = Math.round(parsed.data.gross * 100);
    const policy = await prisma.policy.findUnique({
      where: { id: policyId },
      include: {
        listing: {
          include: {
            property: { include: { mortgage: true, owner: true } },
            contributions: { where: { status: "SUCCEEDED" }, include: { user: true } },
            quote: true,
          },
        },
      },
    });
    if (!policy) {
      res.status(404).json({ error: "Policy not found." });
      return;
    }

    const mortgageCents = policy.listing.property.mortgage?.outstandingBalanceCents ?? 0;
    const coverageCents = policy.listing.quote.coverageCents;
    if (coverageCents !== null && grossCents > coverageCents) {
      res.status(400).json({
        error: `Gross proceeds cannot exceed the policy's coverage of ${usd(coverageCents)}. ${usd(grossCents)} was entered.`,
      });
      return;
    }

    const ownerBps = bps(
      policy.listing.ownerContributionCents,
      policy.listing.premiumTargetCents,
    );
    const split = waterfall({
      grossCents,
      mortgageCents,
      ownerContributionBps: ownerBps,
    });

    const funderTotal = policy.listing.contributions
      .filter((row) => row.userId !== policy.listing.property.ownerId)
      .reduce((sum, row) => sum + row.amountCents, 0);

    const lines: Array<{
      payee: "LENDER" | "OWNER" | "FUNDER";
      amountCents: number;
      userId?: string;
      note: string;
    }> = [
      {
        payee: "LENDER",
        amountCents: split.lenderCents,
        note: policy.listing.property.mortgage?.lenderName ?? "Lender",
      },
      {
        payee: "OWNER",
        amountCents: split.ownerCents,
        userId: policy.listing.property.ownerId,
        note: `Owner share of net (${(ownerBps / 100).toFixed(1)}% of premium contributed)`,
      },
    ];

    // Rounding each share independently lets the lines sum to more or less than
    // the pool, so the last funder absorbs the residual and the lines always
    // total exactly funderPoolCents.
    const funderContributions = policy.listing.contributions.filter(
      (row) => row.userId !== policy.listing.property.ownerId,
    );
    let allocatedCents = 0;
    funderContributions.forEach((contribution, index) => {
      const isLast = index === funderContributions.length - 1;
      const share = isLast
        ? split.funderPoolCents - allocatedCents
        : funderTotal > 0
          ? Math.round((split.funderPoolCents * contribution.amountCents) / funderTotal)
          : 0;
      allocatedCents += share;
      lines.push({
        payee: "FUNDER",
        amountCents: share,
        userId: contribution.userId,
        note: `${contribution.user.email} pro-rata`,
      });
    });

    const text = [
      "Manual payout instruction — not an automated disbursement",
      `Policy ${policy.policyNumber}`,
      `Gross ${grossCents} cents`,
      ...lines.map((line) => `${line.payee} ${line.amountCents} ${line.note}`),
      "FiSure is not the insurer. Carrier confirmation is required before these amounts move.",
    ].join("\n");

    const key = safeKey(["payouts", policy.id, `instruction-${Date.now()}.txt`]);
    await putObject({ key, body: Buffer.from(text), mimeType: "text/plain" });

    const payout = await prisma.payout.create({
      data: {
        policyId,
        grossCents,
        mortgageCents,
        ownerCents: split.ownerCents,
        funderPoolCents: split.funderPoolCents,
        ownerContributionBps: ownerBps,
        status: "INSTRUCTED",
        instructionKey: key,
        lines: { create: lines },
      },
      include: { lines: true },
    });

    await prisma.document.create({
      data: {
        kind: "PAYOUT_INSTRUCTION",
        filename: "payout-instruction.txt",
        storageKey: key,
        mimeType: "text/plain",
        policyId,
        listingId: policy.listingId,
        uploadedById: req.user!.id,
      },
    });

    // BRD §5/§7.3: "1099 and tax documentation generated for all payout recipients."
    // One informational tax document per recipient (owner + each funder — the lender
    // isn't a platform user and doesn't get one). Real 1099 filing (TIN collection,
    // IRS e-file) isn't implemented — this is a downloadable record for the
    // recipient's own accountant, tagged so only that recipient (or admin/carrier)
    // can retrieve it via the existing documents IDOR check.
    const taxYear = new Date().getFullYear();
    const emailByUserId = new Map<string, string>();
    emailByUserId.set(policy.listing.property.ownerId, policy.listing.property.owner.email);
    for (const c of policy.listing.contributions) emailByUserId.set(c.userId, c.user.email);

    for (const line of payout.lines) {
      if (!line.userId || line.payee === "LENDER") continue;
      const recipientEmail = emailByUserId.get(line.userId) ?? "unknown";
      const taxText = [
        `FiSure Payout Tax Record — Tax Year ${taxYear}`,
        `Recipient: ${recipientEmail}`,
        `Policy: ${policy.policyNumber}`,
        `Role: ${line.payee === "OWNER" ? "Property owner" : "Crowdfunder"}`,
        `Amount: ${usd(line.amountCents)}`,
        `Payout date: ${payout.createdAt.toISOString().slice(0, 10)}`,
        "",
        "This is an informational record for your own tax preparation, not an official",
        "IRS Form 1099. FiSure is a marketplace operator, not the insurer, underwriter,",
        "or guarantor of this payout.",
      ].join("\n");
      const taxKey = safeKey(["payouts", policy.id, `tax-record-${line.id}.txt`]);
      await putObject({ key: taxKey, body: Buffer.from(taxText), mimeType: "text/plain" });
      await prisma.document.create({
        data: {
          kind: "TAX_DOCUMENT",
          filename: `tax-record-${taxYear}.txt`,
          storageKey: taxKey,
          mimeType: "text/plain",
          policyId,
          listingId: policy.listingId,
          uploadedById: line.userId,
        },
      });
    }

    res.json({ ok: true, split, payout });
  }),
);
