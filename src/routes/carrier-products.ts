import { Router } from "express";
import { z } from "zod";
import { Peril, PropertyType, type Prisma } from "@prisma/client";
import { prisma } from "../lib/db.js";
import { requireAuth, requireRole, wrap } from "../middleware/auth.js";

export const carrierProductsRouter = Router();

const productSchema = z.object({
  name: z.string().trim().min(1, "Product name is required."),
  peril: z.enum(["FL_HURRICANE", "FL_FLOOD", "CA_WILDFIRE", "CA_EARTHQUAKE"], {
    message: "Select a covered peril.",
  }),
  propertyType: z.enum(["RESIDENTIAL", "COMMERCIAL"]).optional().default("RESIDENTIAL"),
  states: z.string().trim().min(1, "States are required (e.g. FL or CA)."),
  triggerDescription: z.string().trim().min(1, "Trigger description is required."),
  payoutSchedule: z.string().trim().optional().default(""),
  active: z.union([z.boolean(), z.string()]).optional().default(true),
});

function parsePayoutSchedule(raw: string) {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return "INVALID_JSON" as const;
  }
}

carrierProductsRouter.get(
  "/",
  requireAuth,
  requireRole("CARRIER", "ADMIN"),
  wrap(async (req, res) => {
    const products = await prisma.carrierProduct.findMany({
      where:
        req.user!.role === "CARRIER" && req.user!.carrierId
          ? { carrierId: req.user!.carrierId }
          : {},
      orderBy: { name: "asc" },
    });
    res.json({ products });
  }),
);

carrierProductsRouter.post(
  "/",
  requireAuth,
  requireRole("CARRIER", "ADMIN"),
  wrap(async (req, res) => {
    if (req.user!.role === "CARRIER" && !req.user!.carrierId) {
      res.status(403).json({ error: "Your account is not linked to a carrier." });
      return;
    }
    const parsed = productSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid product." });
      return;
    }
    const payoutSchedule = parsePayoutSchedule(parsed.data.payoutSchedule);
    if (payoutSchedule === "INVALID_JSON") {
      res.status(400).json({ error: "Payout schedule must be valid JSON, or left blank." });
      return;
    }
    const carrierId =
      req.user!.role === "ADMIN" ? String(req.body?.carrierId ?? "") : req.user!.carrierId!;
    if (!carrierId) {
      res.status(400).json({ error: "carrierId is required." });
      return;
    }
    const product = await prisma.carrierProduct.create({
      data: {
        carrierId,
        name: parsed.data.name,
        peril: parsed.data.peril as Peril,
        propertyType: parsed.data.propertyType as PropertyType,
        states: parsed.data.states,
        triggerDescription: parsed.data.triggerDescription,
        payoutSchedule: payoutSchedule ?? undefined,
        active: parsed.data.active === true || parsed.data.active === "on" || parsed.data.active === "true",
      },
    });
    res.status(201).json({ product });
  }),
);

carrierProductsRouter.patch(
  "/:id",
  requireAuth,
  requireRole("CARRIER", "ADMIN"),
  wrap(async (req, res) => {
    const product = await prisma.carrierProduct.findUnique({ where: { id: req.params.id as string } });
    if (!product) {
      res.status(404).json({ error: "Product not found." });
      return;
    }
    if (req.user!.role === "CARRIER" && product.carrierId !== req.user!.carrierId) {
      res.status(403).json({ error: "This product is not in your book." });
      return;
    }
    const parsed = productSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid update." });
      return;
    }
    let payoutSchedule: Prisma.InputJsonValue | undefined;
    if (parsed.data.payoutSchedule !== undefined) {
      payoutSchedule = parsePayoutSchedule(parsed.data.payoutSchedule);
      if (payoutSchedule === "INVALID_JSON") {
        res.status(400).json({ error: "Payout schedule must be valid JSON, or left blank." });
        return;
      }
    }
    const updated = await prisma.carrierProduct.update({
      where: { id: product.id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.peril !== undefined ? { peril: parsed.data.peril as Peril } : {}),
        ...(parsed.data.propertyType !== undefined
          ? { propertyType: parsed.data.propertyType as PropertyType }
          : {}),
        ...(parsed.data.states !== undefined ? { states: parsed.data.states } : {}),
        ...(parsed.data.triggerDescription !== undefined
          ? { triggerDescription: parsed.data.triggerDescription }
          : {}),
        ...(parsed.data.payoutSchedule !== undefined ? { payoutSchedule } : {}),
        ...(parsed.data.active !== undefined
          ? { active: parsed.data.active === true || parsed.data.active === "on" || parsed.data.active === "true" }
          : {}),
      },
    });
    res.json({ product: updated });
  }),
);
