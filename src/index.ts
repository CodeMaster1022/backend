import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { authRouter } from "./routes/auth.js";
import { waitlistRouter } from "./routes/waitlist.js";
import { propertiesRouter } from "./routes/properties.js";
import { quotesRouter } from "./routes/quotes.js";
import { listingsRouter } from "./routes/listings.js";
import { triggersRouter } from "./routes/triggers.js";
import { payoutsRouter } from "./routes/payouts.js";
import { adminRouter } from "./routes/admin.js";
import { documentsRouter } from "./routes/documents.js";
import { claimsRouter } from "./routes/claims.js";
import { notificationsRouter } from "./routes/notifications.js";
import { carrierProductsRouter } from "./routes/carrier-products.js";
import { organizationsRouter } from "./routes/organizations.js";
import { invitesRouter } from "./routes/invites.js";
import { usersRouter } from "./routes/users.js";
import { loadSession } from "./middleware/auth.js";
import { startSchedulers } from "./lib/scheduler.js";
import { allowedOrigins } from "./lib/origins.js";
import { webhooksRouter } from "./routes/webhooks.js";

const app = express();

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);
app.use(cookieParser());
// Stripe webhook signature verification needs the raw request body, so this
// route is mounted with a raw parser before the global JSON parser below —
// once express.json() runs for a request, the raw bytes are gone.
app.use("/webhooks", express.raw({ type: "application/json" }), webhooksRouter);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(loadSession);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "fisure-server" });
});

app.use("/auth", authRouter);
app.use("/waitlist", waitlistRouter);
app.use("/properties", propertiesRouter);
app.use("/quotes", quotesRouter);
app.use("/listings", listingsRouter);
app.use("/triggers", triggersRouter);
app.use("/payouts", payoutsRouter);
app.use("/admin", adminRouter);
app.use("/documents", documentsRouter);
app.use("/claims", claimsRouter);
app.use("/notifications", notificationsRouter);
app.use("/carrier-products", carrierProductsRouter);
app.use("/organizations", organizationsRouter);
app.use("/invites", invitesRouter);
app.use("/users", usersRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  const message = err instanceof Error ? err.message : "Server error";
  res.status(500).json({ error: message });
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`FiSure API listening on http://localhost:${port}`);
  startSchedulers();
});
