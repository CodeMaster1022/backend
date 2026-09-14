import { Router } from "express";
import { prisma } from "../lib/db.js";
import { requireAuth, wrap } from "../middleware/auth.js";
import { getObject } from "../lib/storage.js";

export const documentsRouter = Router();

documentsRouter.get(
  "/mine",
  requireAuth,
  wrap(async (req, res) => {
    const userId = req.user!.id;
    // TAX_DOCUMENT is per-recipient — only the "I uploaded/was tagged as recipient
    // of this" branch should ever surface one, never the general "I own this
    // property/listing" branches (see the matching rule in GET /:id below).
    const documents = await prisma.document.findMany({
      where: {
        OR: [
          { uploadedById: userId },
          { kind: { not: "TAX_DOCUMENT" }, property: { ownerId: userId } },
          { kind: { not: "TAX_DOCUMENT" }, listing: { property: { ownerId: userId } } },
          { kind: { not: "TAX_DOCUMENT" }, policy: { listing: { property: { ownerId: userId } } } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ documents });
  }),
);

documentsRouter.get(
  "/:id",
  requireAuth,
  wrap(async (req, res) => {
    const doc = await prisma.document.findUnique({
      where: { id: req.params.id as string },
      include: {
        property: { select: { ownerId: true } },
        listing: { select: { id: true, property: { select: { ownerId: true } } } },
        policy: {
          select: {
            listingId: true,
            listing: { select: { id: true, property: { select: { ownerId: true } } } },
          },
        },
      },
    });
    if (!doc) {
      res.status(404).json({ error: "Document not found." });
      return;
    }

    const ownerId =
      doc.property?.ownerId ??
      doc.listing?.property.ownerId ??
      doc.policy?.listing.property.ownerId ??
      null;
    const listingId = doc.listingId ?? doc.policy?.listingId ?? null;

    const user = req.user!;
    // TAX_DOCUMENT is per-recipient (one funder's payout share is private from the
    // property owner and every other funder) — it must NOT fall through to the
    // general "property owner can see anything on their listing" rule below.
    let allowed =
      user.role === "ADMIN" ||
      user.role === "CARRIER" ||
      doc.uploadedById === user.id ||
      (doc.kind !== "TAX_DOCUMENT" && ownerId === user.id);

    if (!allowed && user.role === "FUNDER" && doc.kind === "POLICY" && listingId) {
      const contribution = await prisma.contribution.findFirst({
        where: { listingId, userId: user.id, status: "SUCCEEDED" },
      });
      allowed = Boolean(contribution);
    }

    if (!allowed) {
      res.status(403).json({ error: "Not allowed." });
      return;
    }

    const body = await getObject(doc.storageKey);
    res.setHeader("Content-Type", doc.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${doc.filename}"`);
    res.send(body);
  }),
);
