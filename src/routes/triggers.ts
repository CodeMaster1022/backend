import { Router } from "express";
import { prisma } from "../lib/db.js";
import { requireAuth, requireRole, wrap } from "../middleware/auth.js";
import { radiusKmForPeril } from "../lib/labels.js";
import { sendNotificationEmails } from "../lib/notify.js";
import { parsePagination, paginationMeta } from "../lib/pagination.js";
import type { Peril } from "@prisma/client";

export const triggersRouter = Router();

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const toRad = (n: number) => (n * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

async function fetchJson(url: string) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Feed ${url} returned ${response.status}`);
  return response.json();
}

async function notifyTriggerMatch(watch: {
  policy: {
    listing: {
      id: string;
      property: { address: string; city: string; state: string; ownerId: string };
      contributions: Array<{ userId: string; status: string }>;
    };
  };
}) {
  const listing = watch.policy.listing;
  const title = `Possible trigger event near ${listing.property.city}, ${listing.property.state}`;
  const body = `A candidate event was detected within range of ${listing.property.address}. A carrier must confirm before any payout.`;

  const recipientIds = new Set<string>([listing.property.ownerId]);
  for (const contribution of listing.contributions) {
    if (contribution.status === "SUCCEEDED") recipientIds.add(contribution.userId);
  }

  await prisma.notification.createMany({
    data: Array.from(recipientIds).map((userId) => ({
      userId,
      kind: "TRIGGER_MATCH" as const,
      title,
      body,
      listingId: listing.id,
    })),
  });
  await sendNotificationEmails(recipientIds, title, body);
}

async function evaluateEvents(
  events: Array<{ source: string; peril: string; lat: number; lng: number; payload: unknown }>,
) {
  const watches = await prisma.triggerWatch.findMany({
    where: { active: true },
    include: {
      policy: {
        include: { listing: { include: { property: true, contributions: true } } },
      },
    },
  });
  let written = 0;
  for (const watch of watches) {
    const related = events.filter((event) => event.peril === watch.peril);
    if (related.length === 0) {
      await prisma.triggerEventLog.create({
        data: {
          policyId: watch.policyId,
          source: "poll",
          payload: { message: "No candidate events in this cycle" },
          matched: false,
          notes: "Evaluated; no match",
        },
      });
      written += 1;
      continue;
    }
    for (const event of related) {
      const distance = haversineKm(
        { lat: watch.lat, lng: watch.lng },
        { lat: event.lat, lng: event.lng },
      );
      const radius = watch.radiusKm || radiusKmForPeril(watch.peril);
      const matched = distance <= radius;
      await prisma.triggerEventLog.create({
        data: {
          policyId: watch.policyId,
          source: event.source,
          payload: JSON.parse(JSON.stringify(event.payload)),
          matched,
          notes: `distanceKm=${distance.toFixed(1)} radiusKm=${radius}`,
        },
      });
      written += 1;
      if (matched) {
        await notifyTriggerMatch(watch);
      }
    }
  }
  return written;
}

triggersRouter.get(
  "/",
  requireAuth,
  requireRole("CARRIER", "ADMIN"),
  wrap(async (req, res) => {
    const eventsWhere =
      req.user!.role === "CARRIER" && req.user!.carrierId
        ? { policy: { carrierId: req.user!.carrierId } }
        : {};
    const { page, pageSize, skip, take } = parsePagination(req.query);
    const [events, total, policies] = await Promise.all([
      prisma.triggerEventLog.findMany({
        where: eventsWhere,
        include: {
          policy: { include: { listing: { include: { property: true } } } },
        },
        orderBy: { evaluatedAt: "desc" },
        skip,
        take,
      }),
      prisma.triggerEventLog.count({ where: eventsWhere }),
      prisma.policy.findMany({
        where:
          req.user!.role === "CARRIER" && req.user!.carrierId
            ? { carrierId: req.user!.carrierId, active: true }
            : { active: true },
        include: { listing: { include: { property: true } }, watch: true },
      }),
    ]);
    res.json({ events, policies, ...paginationMeta(total, page, pageSize) });
  }),
);

type CandidateEvent = {
  source: string;
  peril: string;
  lat: number;
  lng: number;
  payload: unknown;
};

/**
 * No FEMA NFHL / NASA FIRMS account is wired up yet (Phase 3 — needs real API
 * keys). Until then, generate clearly-labeled simulated readings against each
 * active watch for these two perils so the monitoring loop and carrier
 * confirmation flow are exercised end-to-end. These must never be confused
 * with the real NOAA/USGS feeds below — source names and payloads always say
 * "SIMULATED".
 */
async function simulatedFeedEvents(peril: "FL_FLOOD" | "CA_WILDFIRE", source: string) {
  const watches = await prisma.triggerWatch.findMany({ where: { active: true, peril } });
  const events: CandidateEvent[] = [];
  for (const watch of watches) {
    if (Math.random() >= 0.08) continue;
    events.push({
      source,
      peril,
      lat: watch.lat,
      lng: watch.lng,
      payload: {
        simulated: true,
        note: `Simulated reading — no live feed integrated yet for ${peril}.`,
      },
    });
  }
  return events;
}

export async function runTriggerPoll() {
  const events: CandidateEvent[] = [];

  try {
    const quakes = await fetchJson(
      "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson",
    );
    for (const feature of quakes.features ?? []) {
      const mag = feature.properties?.mag ?? 0;
      if (mag < 6) continue;
      const [lng, lat] = feature.geometry?.coordinates ?? [];
      events.push({ source: "USGS", peril: "CA_EARTHQUAKE", lat, lng, payload: feature });
    }
  } catch (error) {
    console.error("USGS poll failed", error);
  }

  try {
    const storms = await fetchJson("https://www.nhc.noaa.gov/CurrentStorms.json");
    for (const storm of storms.activeStorms ?? []) {
      // storm.latitude/longitude are display strings like "17.3N"/"128.3W" — Number()
      // on those is NaN. The *Numeric fields are the pre-parsed, correctly-signed floats.
      const lat = Number(storm.latitudeNumeric);
      const lng = Number(storm.longitudeNumeric);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      // BRD trigger is "Category 3+ hurricane landfall" — classification "HU" and
      // sustained wind >= 96 kt is the Cat 3 threshold. True landfall (coastline
      // crossing) detection would need real GIS data; radius-based proximity in
      // evaluateEvents() is the proxy used here until that's built.
      const isHurricane = storm.classification === "HU";
      const intensityKt = Number(storm.intensity);
      if (!isHurricane || !Number.isFinite(intensityKt) || intensityKt < 96) continue;
      events.push({ source: "NOAA_NHC", peril: "FL_HURRICANE", lat, lng, payload: storm });
    }
  } catch (error) {
    console.error("NOAA poll failed", error);
  }

  try {
    events.push(...(await simulatedFeedEvents("FL_FLOOD", "SIMULATED_FEMA_NFHL")));
  } catch (error) {
    console.error("Simulated FEMA flood feed failed", error);
  }

  try {
    events.push(...(await simulatedFeedEvents("CA_WILDFIRE", "SIMULATED_NASA_FIRMS")));
  } catch (error) {
    console.error("Simulated NASA FIRMS feed failed", error);
  }

  const written = await evaluateEvents(events);
  return { written, liveEvents: events.length };
}

triggersRouter.post(
  "/poll",
  requireAuth,
  requireRole("ADMIN", "CARRIER"),
  wrap(async (_req, res) => {
    const result = await runTriggerPoll();
    res.json(result);
  }),
);

triggersRouter.post(
  "/mock",
  requireAuth,
  requireRole("ADMIN", "CARRIER"),
  wrap(async (req, res) => {
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    const peril = String(req.body?.peril ?? "CA_EARTHQUAKE") as Peril;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      res.status(400).json({ error: "lat and lng are required." });
      return;
    }
    const written = await evaluateEvents([
      {
        source: "MOCK",
        peril,
        lat,
        lng,
        payload: { mock: true, lat, lng, peril },
      },
    ]);
    res.json({ written });
  }),
);

triggersRouter.post(
  "/:id/confirm",
  requireAuth,
  requireRole("CARRIER", "ADMIN"),
  wrap(async (req, res) => {
    const confirmation = String(req.body?.confirmation ?? "");
    if (confirmation !== "CONFIRMED" && confirmation !== "NOT_MET") {
      res.status(400).json({ error: "Choose confirmed or not met." });
      return;
    }
    await prisma.triggerEventLog.update({
      where: { id: req.params.id as string },
      data: {
        confirmation,
        confirmedById: req.user!.id,
        confirmedAt: new Date(),
      },
    });
    res.json({ ok: true });
  }),
);
