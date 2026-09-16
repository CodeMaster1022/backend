import { Router } from "express";
import type Stripe from "stripe";
import { stripe } from "../lib/stripe.js";
import { prisma } from "../lib/db.js";
import { finalizeContribution } from "../lib/contributions.js";

export const webhooksRouter = Router();

webhooksRouter.post("/stripe", async (req, res) => {
  if (!stripe) {
    res.status(400).send("Stripe is not configured.");
    return;
  }
  const signature = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!signature || typeof signature !== "string" || !webhookSecret) {
    res.status(400).send("Missing signature or webhook secret.");
    return;
  }

  let event: Stripe.Event;
  try {
    // req.body is the raw Buffer here — see index.ts, which mounts this
    // router with express.raw() ahead of the global JSON body parser.
    event = stripe.webhooks.constructEvent(req.body as Buffer, signature, webhookSecret);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err instanceof Error ? err.message : err);
    res.status(400).send("Invalid signature.");
    return;
  }

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const session = event.data.object as Stripe.Checkout.Session;
    const listingId = session.metadata?.listingId;
    const userId = session.metadata?.userId;
    const asOwner = session.metadata?.asOwner === "true";
    const paymentIntentId =
      typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
    const amountCents = session.amount_total;

    if (!listingId || !userId || !paymentIntentId || amountCents == null) {
      console.error(`Stripe webhook ${event.id}: missing listingId/userId/payment_intent/amount_total.`);
      res.json({ received: true });
      return;
    }

    // Stripe can deliver the same event more than once — this is the
    // application-layer uniqueness check that replaces the DB-level unique
    // index Contribution.stripePaymentIntentId can't have on Mongo (see the
    // comment on that field in schema.prisma).
    const existing = await prisma.contribution.findFirst({
      where: { stripePaymentIntentId: paymentIntentId },
    });
    if (existing) {
      res.json({ received: true });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (!user) {
      console.error(`Stripe webhook ${event.id}: user ${userId} not found.`);
      res.json({ received: true });
      return;
    }

    const result = await finalizeContribution({
      listingId,
      userId,
      userRole: user.role,
      amountCents,
      asOwner,
      stripePaymentIntentId: paymentIntentId,
      note: "Stripe checkout",
    });

    if (!result.ok) {
      // Payment already succeeded on Stripe's side, but listing state changed
      // in the meantime (e.g. someone else's contribution filled the
      // remaining premium first) and it can no longer be applied. Refund
      // immediately rather than silently holding money with nothing to show
      // for it.
      console.error(
        `Contribution finalize failed after Stripe payment succeeded (payment_intent=${paymentIntentId}): ${result.error}. Issuing refund.`,
      );
      try {
        await stripe.refunds.create({ payment_intent: paymentIntentId });
      } catch (refundErr) {
        console.error(
          `CRITICAL: auto-refund failed for payment_intent=${paymentIntentId} — needs manual handling:`,
          refundErr,
        );
      }
    }
  }

  res.json({ received: true });
});
