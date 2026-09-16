import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { Peril, PropertyType, StateCode } from "@prisma/client";
import { prisma } from "../lib/db.js";
import { requireAuth, requireKyc, requireRole, wrap } from "../middleware/auth.js";
import { dollarsToCents, requiredCoverageCents, usd } from "../lib/money.js";
import { putObject, safeKey } from "../lib/storage.js";
import { notifyCarrierNewQuoteRequest } from "../lib/notify.js";
import { parsePagination, paginationMeta } from "../lib/pagination.js";

export const propertiesRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8_000_000 } });

const submitPropertySchema = z.object({
  address: z.string().trim().min(1, "Address is required."),
  city: z.string().trim().min(1, "City is required."),
  county: z.string().trim().optional().default(""),
  state: z.enum(["FL", "CA"], { message: "FiSure only covers Florida and California properties." }),
  zip: z.string().trim().min(1, "ZIP code is required."),
  lat: z.coerce.number(),
  lng: z.coerce.number(),
  peril: z.enum(["FL_HURRICANE", "FL_FLOOD", "CA_WILDFIRE", "CA_EARTHQUAKE"], {
    message: "Select a covered peril.",
  }),
  propertyType: z.enum(["RESIDENTIAL", "COMMERCIAL"]).optional().default("RESIDENTIAL"),
  mortgage: z.string().trim().default("0"),
  value: z.string().trim().min(1, "Estimated value is required."),
  lenderName: z.string().trim().min(1, "Lender name is required."),
  lenderEmail: z
    .union([z.literal(""), z.string().trim().email("Enter a valid lender email.")])
    .optional()
    .default(""),
  servicer: z.string().trim().optional().default(""),
  sameRiskCovered: z.string().optional(),
  ownerDays: z.coerce.number().int().min(1).max(365).optional().default(45),
});

propertiesRouter.get(
  "/",
  requireAuth,
  wrap(async (req, res) => {
    const where = req.user!.role === "ADMIN" ? {} : { ownerId: req.user!.id };
    const { page, pageSize, skip, take } = parsePagination(req.query);
    const [properties, total] = await Promise.all([
      prisma.property.findMany({
        where,
        include: {
          mortgage: true,
          eligibility: { orderBy: { checkedAt: "desc" }, take: 1 },
          listings: { include: { quote: true, policy: true } },
          quoteRequests: { include: { quote: true, carrierProduct: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.property.count({ where }),
    ]);
    res.json({ properties, ...paginationMeta(total, page, pageSize) });
  }),
);

propertiesRouter.get(
  "/:id",
  requireAuth,
  wrap(async (req, res) => {
    const property = await prisma.property.findUnique({
      where: { id: req.params.id as string },
      include: {
        mortgage: true,
        owner: { select: { id: true, name: true, email: true } },
        eligibility: { orderBy: { checkedAt: "desc" } },
        documents: true,
        listings: {
          include: {
            quote: true,
            policy: true,
            contributions: { include: { user: { select: { email: true, name: true } } } },
            ledger: true,
          },
        },
        quoteRequests: { include: { quote: true, carrierProduct: true } },
      },
    });
    if (!property) {
      res.status(404).json({ error: "Property not found." });
      return;
    }
    const allowed =
      req.user!.role === "ADMIN" ||
      req.user!.role === "CARRIER" ||
      property.ownerId === req.user!.id;
    if (!allowed) {
      res.status(403).json({ error: "Not allowed." });
      return;
    }
    res.json({ property });
  }),
);

propertiesRouter.post(
  "/:id/reverify",
  requireAuth,
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    const property = await prisma.property.findUnique({
      where: { id: req.params.id as string },
      include: {
        mortgage: true,
        listings: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: { quote: true, policy: true },
        },
      },
    });
    if (!property) {
      res.status(404).json({ error: "Property not found." });
      return;
    }

    const mortgageBalance = property.mortgage?.outstandingBalanceCents ?? 0;
    const required = requiredCoverageCents(mortgageBalance);
    const latestListing = property.listings[0];
    const proposedCoverage = latestListing?.quote.coverageCents ?? property.estimatedValueCents;
    const bufferOk = proposedCoverage >= required;

    const check = await prisma.eligibilityCheck.create({
      data: {
        propertyId: property.id,
        bufferPassed: bufferOk,
        kycPassed: true,
        sameRiskCovered: false,
        inRiskZone: true,
        requiredCoverageCents: required,
        proposedCoverageCents: proposedCoverage,
        notes: bufferOk
          ? "Annual re-verification: 35% equity buffer still satisfied."
          : `Annual re-verification FAILED: coverage ${usd(proposedCoverage)} is below required ${usd(required)} (mortgage × 1.35). Listing should be suspended pending re-qualification.`,
      },
    });

    res.json({ eligibility: check, bufferPassed: bufferOk });
  }),
);

propertiesRouter.post(
  "/",
  requireAuth,
  requireKyc,
  requireRole("OWNER", "ADMIN"),
  upload.single("deed"),
  wrap(async (req, res) => {
    const parsed = submitPropertySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid submission." });
      return;
    }
    const body = parsed.data;
    const address = body.address;
    const peril = body.peril as Peril;
    const mortgageBalance = dollarsToCents(body.mortgage);
    const estimatedValue = dollarsToCents(body.value);
    const lenderName = body.lenderName;
    const lenderEmail = body.lenderEmail;
    const servicer = body.servicer;
    const sameRiskCovered = body.sameRiskCovered === "on" || body.sameRiskCovered === "true";
    const ownerDays = body.ownerDays;
    const place = {
      city: body.city,
      county: body.county || body.city,
      state: body.state as StateCode,
      zip: body.zip,
      lat: body.lat,
      lng: body.lng,
    };

    if (estimatedValue <= 0) {
      res.status(400).json({ error: "Enter an estimated value greater than zero." });
      return;
    }
    if (
      (place.state === "FL" && !peril.startsWith("FL_")) ||
      (place.state === "CA" && !peril.startsWith("CA_"))
    ) {
      res.status(400).json({ error: "Peril must match the property's state." });
      return;
    }

    const required = requiredCoverageCents(mortgageBalance);
    const bufferOk = estimatedValue >= required;
    const kycPassed = req.user!.kycStatus === "PASSED";
    const openClaim = await prisma.claim.findFirst({
      where: { status: "OPEN", property: { ownerId: req.user!.id, peril } },
    });
    const hasOpenClaim = Boolean(openClaim);

    const property = await prisma.property.create({
      data: {
        ownerId: req.user!.id,
        address,
        city: place.city,
        county: place.county,
        state: place.state,
        zip: place.zip,
        lat: place.lat,
        lng: place.lng,
        estimatedValueCents: estimatedValue,
        peril,
        propertyType: body.propertyType as PropertyType,
        mortgage: {
          create: {
            lenderName,
            servicer: servicer || null,
            outstandingBalanceCents: mortgageBalance,
            lenderEmail: lenderEmail || null,
          },
        },
      },
    });

    const deed = req.file;
    if (deed) {
      const key = safeKey(["properties", property.id, "deed", deed.originalname]);
      await putObject({
        key,
        body: deed.buffer,
        mimeType: deed.mimetype || "application/octet-stream",
      });
      await prisma.document.create({
        data: {
          kind: "DEED",
          filename: deed.originalname,
          storageKey: key,
          mimeType: deed.mimetype || "application/octet-stream",
          propertyId: property.id,
          uploadedById: req.user!.id,
        },
      });
    }

    await prisma.eligibilityCheck.create({
      data: {
        propertyId: property.id,
        bufferPassed: bufferOk,
        kycPassed,
        sameRiskCovered,
        inRiskZone: true,
        openClaim: hasOpenClaim,
        requiredCoverageCents: required,
        proposedCoverageCents: estimatedValue,
        notes: hasOpenClaim
          ? "Failed: an open claim exists on another property for this peril."
          : bufferOk
            ? "Submission buffer used estimated value vs mortgage × 1.35. Quote coverage will be re-checked."
            : `Failed 35% buffer: estimated value below required coverage of ${usd(required)}.`,
      },
    });

    if (!bufferOk || sameRiskCovered || !kycPassed || hasOpenClaim) {
      res.status(201).json({ propertyId: property.id, eligibility: "fail" });
      return;
    }

    // Carrier/product selection is now a separate owner-facing step (see
    // GET /:id/products and POST /:id/request-quote below) instead of
    // auto-matching to whichever product happens to be active for the peril —
    // owners should see and choose from a real marketplace of carrier products,
    // matching the BRD §2.1 carrier-marketplace flow.
    res.status(201).json({ propertyId: property.id, eligibility: "pass" });
  }),
);

propertiesRouter.get(
  "/:id/products",
  requireAuth,
  wrap(async (req, res) => {
    const property = await prisma.property.findUnique({ where: { id: req.params.id as string } });
    if (!property) {
      res.status(404).json({ error: "Property not found." });
      return;
    }
    if (property.ownerId !== req.user!.id && req.user!.role !== "ADMIN") {
      res.status(403).json({ error: "Not allowed." });
      return;
    }
    const products = await prisma.carrierProduct.findMany({
      where: { peril: property.peril, propertyType: property.propertyType, active: true },
      include: { carrier: { select: { name: true } } },
      orderBy: { name: "asc" },
    });
    res.json({ products });
  }),
);

propertiesRouter.post(
  "/:id/request-quote",
  requireAuth,
  wrap(async (req, res) => {
    const propertyId = req.params.id as string;
    const carrierProductId = String(req.body?.carrierProductId ?? "");
    if (!carrierProductId) {
      res.status(400).json({ error: "Select a carrier product." });
      return;
    }

    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      include: {
        eligibility: { orderBy: { checkedAt: "desc" }, take: 1 },
        mortgage: true,
      },
    });
    if (!property) {
      res.status(404).json({ error: "Property not found." });
      return;
    }
    if (property.ownerId !== req.user!.id && req.user!.role !== "ADMIN") {
      res.status(403).json({ error: "Not allowed." });
      return;
    }
    const latestCheck = property.eligibility[0];
    if (
      !latestCheck ||
      !latestCheck.bufferPassed ||
      latestCheck.sameRiskCovered ||
      !latestCheck.kycPassed ||
      latestCheck.openClaim
    ) {
      res.status(400).json({ error: "This property is not currently eligible for a quote." });
      return;
    }

    const existingActive = await prisma.quoteRequest.findFirst({
      where: { propertyId, status: { in: ["PENDING", "ACCEPTED"] } },
      include: { carrierProduct: { select: { name: true } } },
    });
    if (existingActive) {
      res.status(400).json({
        error: `A quote request is already ${existingActive.status.toLowerCase()} with ${existingActive.carrierProduct.name}.`,
      });
      return;
    }

    const product = await prisma.carrierProduct.findUnique({ where: { id: carrierProductId } });
    if (
      !product ||
      !product.active ||
      product.peril !== property.peril ||
      product.propertyType !== property.propertyType
    ) {
      res.status(400).json({ error: "That product is not available for this property." });
      return;
    }

    const pack = {
      propertyId: property.id,
      address: `${property.address}, ${property.city}, ${property.state} ${property.zip}`,
      peril: property.peril,
      mortgageBalance: property.mortgage?.outstandingBalanceCents ?? 0,
      estimatedValue: property.estimatedValueCents,
      productId: product.id,
    };
    const key = safeKey(["properties", property.id, `filepack-${Date.now()}.json`]);
    await putObject({
      key,
      body: Buffer.from(JSON.stringify(pack, null, 2)),
      mimeType: "application/json",
    });
    await prisma.document.create({
      data: {
        kind: "FILE_PACK",
        filename: "submission-pack.json",
        storageKey: key,
        mimeType: "application/json",
        propertyId: property.id,
        uploadedById: req.user!.id,
      },
    });
    const quoteRequest = await prisma.quoteRequest.create({
      data: {
        propertyId: property.id,
        carrierProductId: product.id,
        filePackKey: key,
      },
    });

    await notifyCarrierNewQuoteRequest({
      carrierId: product.carrierId,
      title: "New quote request",
      body: `${property.address}, ${property.city} requested a quote for ${product.name}.`,
    });

    res.status(201).json({ quoteRequestId: quoteRequest.id });
  }),
);
