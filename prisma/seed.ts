import "dotenv/config";
import { PrismaClient, Peril, PropertyType, Role, ListingStatus, type Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { putObject, safeKey } from "../src/lib/storage.js";
import { radiusKmForPeril } from "../src/lib/labels.js";
import { requiredCoverageCents } from "../src/lib/money.js";

const prisma = new PrismaClient();
const PASSWORD = "pilot-pass-2026";

const PRODUCTS: Array<{
  name: string;
  peril: Peril;
  states: string;
  triggerDescription: string;
  payoutSchedule: Prisma.InputJsonValue;
}> = [
  {
    name: "Florida Hurricane Cat 3+",
    peril: Peril.FL_HURRICANE,
    states: "FL",
    triggerDescription:
      "Category 3 or higher hurricane landfall confirmed by NOAA NHC within a 50 km radius of the property.",
    payoutSchedule: { bands: [{ pct: 40 }, { pct: 70 }, { pct: 100 }] },
  },
  {
    name: "Florida Flood Threshold",
    peril: Peril.FL_FLOOD,
    states: "FL",
    triggerDescription:
      "FEMA-declared flood event reaching a defined water-level threshold at or near the property.",
    payoutSchedule: { bands: [{ pct: 50 }, { pct: 100 }] },
  },
  {
    name: "California Wildfire Perimeter",
    peril: Peril.CA_WILDFIRE,
    states: "CA",
    triggerDescription:
      "Satellite-confirmed natural wildfire perimeter (NASA FIRMS / USFS) within 10 km of the property.",
    payoutSchedule: { bands: [{ pct: 100 }] },
  },
  {
    name: "California Earthquake M6.0+",
    peril: Peril.CA_EARTHQUAKE,
    states: "CA",
    triggerDescription:
      "USGS-measured seismic event of magnitude 6.0 or greater within 40 km of the property.",
    payoutSchedule: { bands: [{ pct: 25 }, { pct: 50 }, { pct: 100 }] },
  },
];

async function main() {
  await prisma.payoutLine.deleteMany();
  await prisma.payout.deleteMany();
  await prisma.triggerEventLog.deleteMany();
  await prisma.triggerWatch.deleteMany();
  await prisma.policy.deleteMany();
  await prisma.escrowLedger.deleteMany();
  await prisma.contribution.deleteMany();
  await prisma.disclosureAcceptance.deleteMany();
  await prisma.document.deleteMany();
  await prisma.listing.deleteMany();
  await prisma.quote.deleteMany();
  await prisma.quoteRequest.deleteMany();
  await prisma.eligibilityCheck.deleteMany();
  await prisma.mortgage.deleteMany();
  await prisma.property.deleteMany();
  await prisma.session.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.organization.deleteMany();
  await prisma.carrierProduct.deleteMany();
  await prisma.user.deleteMany();
  await prisma.carrier.deleteMany();
  await prisma.waitlistSignup.deleteMany();

  const passwordHash = await bcrypt.hash(PASSWORD, 12);

  const carrier = await prisma.carrier.create({
    data: { id: "carrier-anchor", name: "Anchor Parametric", slug: "anchor" },
  });

  const productByPeril: Record<string, string> = {};
  for (const product of PRODUCTS) {
    const row = await prisma.carrierProduct.create({
      data: { ...product, carrierId: carrier.id },
    });
    // First product per peril wins the demo-flow reference below — later
    // marketplace-competitor products must not silently swap out the product
    // that existing seeded listings/quotes already reference.
    if (!productByPeril[product.peril]) productByPeril[product.peril] = row.id;
  }

  // A few competing named products so the owner-facing marketplace picker has
  // more than one option per peril to choose between, per client feedback
  // ("Arbol – Residential Hurricane Coverage", "Marsh – Corporate Hurricane
  // Coverage", "Descartes – Corporate Flood Coverage" were the client's own
  // example names — used here as illustrative pilot data pending real carrier
  // onboarding).
  const arbol = await prisma.carrier.create({
    data: { id: "carrier-arbol", name: "Arbol", slug: "arbol" },
  });
  const marsh = await prisma.carrier.create({
    data: { id: "carrier-marsh", name: "Marsh", slug: "marsh" },
  });
  const descartes = await prisma.carrier.create({
    data: { id: "carrier-descartes", name: "Descartes", slug: "descartes" },
  });
  await prisma.carrierProduct.createMany({
    data: [
      {
        carrierId: arbol.id,
        name: "Residential Hurricane Coverage",
        peril: Peril.FL_HURRICANE,
        propertyType: PropertyType.RESIDENTIAL,
        states: "FL",
        triggerDescription:
          "Category 3 or higher hurricane landfall confirmed by NOAA NHC within a 50 km radius of the property.",
        payoutSchedule: { bands: [{ pct: 40 }, { pct: 70 }, { pct: 100 }] },
      },
      {
        carrierId: marsh.id,
        name: "Corporate Hurricane Coverage",
        peril: Peril.FL_HURRICANE,
        propertyType: PropertyType.COMMERCIAL,
        states: "FL",
        triggerDescription:
          "Category 3 or higher hurricane landfall confirmed by NOAA NHC within a 50 km radius of the property.",
        payoutSchedule: { bands: [{ pct: 50 }, { pct: 100 }] },
      },
      {
        carrierId: descartes.id,
        name: "Corporate Flood Coverage",
        peril: Peril.FL_FLOOD,
        propertyType: PropertyType.COMMERCIAL,
        states: "FL",
        triggerDescription:
          "FEMA-declared flood event reaching a defined water-level threshold at or near the property.",
        payoutSchedule: { bands: [{ pct: 100 }] },
      },
    ],
  });

  const org = await prisma.organization.create({
    data: { id: "seed-csr-org", name: "Harbor CSR", approved: true },
  });
  const org2 = await prisma.organization.create({
    data: { id: "seed-csr-org-2", name: "Pacific Resilience Fund", approved: true },
  });
  await prisma.organization.create({
    data: { id: "seed-csr-pending", name: "Everglades Mutual", approved: false },
  });

  const admin = await prisma.user.create({
    data: {
      email: "admin@fisure.local",
      name: "FiSure Admin",
      passwordHash,
      role: Role.ADMIN,
      kycStatus: "PASSED",
    },
  });
  const owner = await prisma.user.create({
    data: {
      email: "owner@fisure.local",
      name: "Alex Owner",
      passwordHash,
      role: Role.OWNER,
      kycStatus: "PASSED",
    },
  });
  const funder = await prisma.user.create({
    data: {
      email: "funder@fisure.local",
      name: "Casey Funder",
      passwordHash,
      role: Role.FUNDER,
      kycStatus: "PASSED",
    },
  });
  await prisma.membership.create({
    data: { userId: funder.id, organizationId: org.id, role: "ADMIN" },
  });
  await prisma.user.create({
    data: {
      email: "carrier@fisure.local",
      name: "Jordan Underwriter",
      passwordHash,
      role: Role.CARRIER,
      kycStatus: "PASSED",
      carrierId: carrier.id,
    },
  });
  const owner2 = await prisma.user.create({
    data: {
      email: "owner2@fisure.local",
      name: "Riley Homeowner",
      passwordHash,
      role: Role.OWNER,
      kycStatus: "PASSED",
    },
  });
  const funder2 = await prisma.user.create({
    data: {
      email: "funder2@fisure.local",
      name: "Morgan Pacific",
      passwordHash,
      role: Role.FUNDER,
      kycStatus: "PASSED",
    },
  });
  await prisma.membership.create({
    data: { userId: funder2.id, organizationId: org2.id, role: "ADMIN" },
  });

  await prisma.disclosureAcceptance.createMany({
    data: [
      { userId: funder.id, version: "v1-pilot-2026" },
      { userId: funder2.id, version: "v1-pilot-2026" },
    ],
  });

  await prisma.waitlistSignup.createMany({
    data: [
      { name: "Pat Waitlist", email: "pat@example.com", role: "CORPORATE", disclosureAccepted: true },
      { name: "Sam Ortega", email: "sam.ortega@lakeside.org", role: "OWNER", disclosureAccepted: true },
      { name: "Nia Chen", email: "nia@bayview-hoa.test", role: "OWNER", disclosureAccepted: true },
      { name: "Greenleaf CSR", email: "csr@greenleaf.test", role: "CORPORATE", disclosureAccepted: true },
      { name: "Descartes BD", email: "bd@carrier.test", role: "CARRIER", disclosureAccepted: true },
    ],
  });

  // 1. Eligibility failed — buffer miss
  const failed = await createProperty({
    ownerId: owner.id,
    address: "14 Cypress Court",
    city: "Naples",
    county: "Collier",
    state: "FL",
    zip: "34102",
    lat: 26.142,
    lng: -81.7948,
    peril: "FL_HURRICANE",
    value: 180_000_00,
    mortgage: 300_000_00,
    lender: "Gulf Coast CU",
  });
  await prisma.eligibilityCheck.create({
    data: {
      propertyId: failed.id,
      bufferPassed: false,
      kycPassed: true,
      sameRiskCovered: false,
      inRiskZone: true,
      requiredCoverageCents: requiredCoverageCents(300_000_00),
      proposedCoverageCents: 180_000_00,
      notes: "Failed 35% buffer: estimated value below mortgage × 1.35.",
    },
  });

  // 2. Awaiting quote
  const miami = await createProperty({
    ownerId: owner.id,
    address: "900 Biscayne Blvd",
    city: "Miami",
    county: "Miami-Dade",
    state: "FL",
    zip: "33132",
    lat: 25.7617,
    lng: -80.1918,
    peril: "FL_FLOOD",
    value: 520_000_00,
    mortgage: 240_000_00,
    lender: "First Miami Bank",
  });
  await filePackAndRequest(miami.id, productByPeril.FL_FLOOD, owner.id, "PENDING");

  // 3. Awaiting owner 15%
  await quotedListing({
    ownerId: owner.id,
    funderId: funder.id,
    orgId: org.id,
    productId: productByPeril.CA_EARTHQUAKE,
    status: "AWAITING_OWNER_FUNDS",
    address: "1215 Q Street",
    city: "Sacramento",
    county: "Sacramento",
    state: "CA",
    zip: "95811",
    lat: 38.5816,
    lng: -121.4944,
    peril: "CA_EARTHQUAKE",
    value: 640_000_00,
    mortgage: 280_000_00,
    lender: "Sacramento Credit Union",
    premium: 3_200_00,
    coverage: 400_000_00,
    funded: 0,
    ownerCents: 0,
  });

  // 4. LIVE Fort Myers hurricane ~62%
  await quotedListing({
    ownerId: owner.id,
    funderId: funder.id,
    orgId: org.id,
    productId: productByPeril.FL_HURRICANE,
    status: "LIVE",
    address: "2210 McGregor Blvd",
    city: "Fort Myers",
    county: "Lee",
    state: "FL",
    zip: "33901",
    lat: 26.6406,
    lng: -81.8723,
    peril: "FL_HURRICANE",
    value: 410_000_00,
    mortgage: 200_000_00,
    lender: "Suncoast Bank",
    premium: 6_400_00,
    coverage: 270_000_00,
    funded: 3_968_00,
    ownerCents: 960_00,
    daysLeft: 18,
  });

  // 5. LIVE Sacramento wildfire
  await quotedListing({
    ownerId: owner.id,
    funderId: funder.id,
    orgId: org.id,
    productId: productByPeril.CA_WILDFIRE,
    status: "LIVE",
    address: "88 Fair Oaks Blvd",
    city: "Sacramento",
    county: "Sacramento",
    state: "CA",
    zip: "95825",
    lat: 38.5816,
    lng: -121.41,
    peril: "CA_WILDFIRE",
    value: 780_000_00,
    mortgage: 310_000_00,
    lender: "Valley Community Bank",
    premium: 4_800_00,
    coverage: 420_000_00,
    funded: 2_160_00,
    ownerCents: 720_00,
    daysLeft: 24,
  });

  // 6. Fully funded, awaiting lender
  await quotedListing({
    ownerId: owner.id,
    funderId: funder.id,
    orgId: org.id,
    productId: productByPeril.FL_FLOOD,
    status: "AWAITING_LENDER",
    address: "55 Brickell Ave",
    city: "Miami",
    county: "Miami-Dade",
    state: "FL",
    zip: "33131",
    lat: 25.761,
    lng: -80.19,
    peril: "FL_FLOOD",
    value: 900_000_00,
    mortgage: 400_000_00,
    lender: "Atlantic Servicing",
    premium: 7_200_00,
    coverage: 540_000_00,
    funded: 7_200_00,
    ownerCents: 1_080_00,
    lenderNamed: false,
  });

  // 7. ACTIVE policy + pending trigger
  const active = await quotedListing({
    ownerId: owner.id,
    funderId: funder.id,
    orgId: org.id,
    productId: productByPeril.CA_EARTHQUAKE,
    status: "ACTIVE",
    address: "400 S Spring Street",
    city: "Los Angeles",
    county: "Los Angeles",
    state: "CA",
    zip: "90013",
    lat: 34.0522,
    lng: -118.2437,
    peril: "CA_EARTHQUAKE",
    value: 1_100_000_00,
    mortgage: 500_000_00,
    lender: "Pacific Mortgage Co",
    premium: 8_500_00,
    coverage: 675_000_00,
    funded: 8_500_00,
    ownerCents: 1_275_00,
    lenderNamed: true,
    bind: true,
    carrierId: carrier.id,
    policyNumber: "FS-CA-SEED001",
  });

  if (active.policyId) {
    await prisma.triggerEventLog.create({
      data: {
        policyId: active.policyId,
        source: "MOCK",
        payload: {
          mock: true,
          mag: 6.2,
          place: "2km W of Los Angeles",
        },
        matched: true,
        confirmation: "PENDING",
        notes: "distanceKm=2.1 radiusKm=40",
      },
    });
  }

  // 8. Top-up window
  await quotedListing({
    ownerId: owner.id,
    funderId: funder.id,
    orgId: org.id,
    productId: productByPeril.FL_HURRICANE,
    status: "TOPUP_WINDOW",
    address: "19 San Carlos Blvd",
    city: "Fort Myers Beach",
    county: "Lee",
    state: "FL",
    zip: "33931",
    lat: 26.45,
    lng: -81.95,
    peril: "FL_HURRICANE",
    value: 360_000_00,
    mortgage: 190_000_00,
    lender: "Island Bank",
    premium: 5_100_00,
    coverage: 270_000_00,
    funded: 4_200_00,
    ownerCents: 765_00,
    topUpDays: 5,
  });

  const declined = await createProperty({
    ownerId: owner2.id,
    address: "410 Ocean Drive",
    city: "Miami Beach",
    county: "Miami-Dade",
    state: "FL",
    zip: "33139",
    lat: 25.7907,
    lng: -80.13,
    peril: "FL_HURRICANE",
    value: 2_400_000_00,
    mortgage: 1_100_000_00,
    lender: "Oceanfront Servicing",
  });
  await prisma.eligibilityCheck.create({
    data: {
      propertyId: declined.id,
      bufferPassed: true,
      kycPassed: true,
      sameRiskCovered: false,
      inRiskZone: true,
      requiredCoverageCents: requiredCoverageCents(1_100_000_00),
      proposedCoverageCents: 1_500_000_00,
      notes: "Seed eligibility passed; carrier declined concentration.",
    },
  });
  const declinedReq = await filePackAndRequest(
    declined.id,
    productByPeril.FL_HURRICANE,
    owner2.id,
    "DECLINED",
  );
  await prisma.quote.create({
    data: {
      quoteRequestId: declinedReq.id,
      decision: "DECLINED",
      notes: "Coastal concentration exceeds Anchor’s mock treaty.",
    },
  });

  await quotedListing({
    ownerId: owner2.id,
    funderId: funder2.id,
    orgId: org2.id,
    productId: productByPeril.FL_HURRICANE,
    status: "LIVE",
    address: "77 Bayshore Blvd",
    city: "Tampa",
    county: "Hillsborough",
    state: "FL",
    zip: "33602",
    lat: 27.9506,
    lng: -82.4572,
    peril: "FL_HURRICANE",
    value: 540_000_00,
    mortgage: 260_000_00,
    lender: "Tampa Bay Credit Union",
    premium: 5_800_00,
    coverage: 351_000_00,
    funded: 1_740_00,
    ownerCents: 870_00,
    daysLeft: 11,
  });

  await quotedListing({
    ownerId: owner2.id,
    funderId: funder.id,
    orgId: org.id,
    productId: productByPeril.FL_FLOOD,
    status: "LIVE",
    address: "12 Duval Street",
    city: "Key West",
    county: "Monroe",
    state: "FL",
    zip: "33040",
    lat: 24.5551,
    lng: -81.78,
    peril: "FL_FLOOD",
    value: 890_000_00,
    mortgage: 420_000_00,
    lender: "Keys Community Bank",
    premium: 9_100_00,
    coverage: 567_000_00,
    funded: 5_460_00,
    ownerCents: 1_365_00,
    daysLeft: 9,
  });

  await quotedListing({
    ownerId: owner.id,
    funderId: funder2.id,
    orgId: org2.id,
    productId: productByPeril.CA_WILDFIRE,
    status: "LIVE",
    address: "2100 Telegraph Ave",
    city: "Oakland",
    county: "Alameda",
    state: "CA",
    zip: "94612",
    lat: 37.8044,
    lng: -122.2712,
    peril: "CA_WILDFIRE",
    value: 950_000_00,
    mortgage: 380_000_00,
    lender: "East Bay Credit Union",
    premium: 6_200_00,
    coverage: 513_000_00,
    funded: 4_340_00,
    ownerCents: 930_00,
    daysLeft: 21,
  });

  await quotedListing({
    ownerId: owner2.id,
    funderId: funder2.id,
    orgId: org2.id,
    productId: productByPeril.CA_WILDFIRE,
    status: "LIVE",
    address: "5 Fourth Street",
    city: "Santa Rosa",
    county: "Sonoma",
    state: "CA",
    zip: "95401",
    lat: 38.4404,
    lng: -122.7141,
    peril: "CA_WILDFIRE",
    value: 720_000_00,
    mortgage: 290_000_00,
    lender: "Sonoma Valley Bank",
    premium: 7_400_00,
    coverage: 400_000_00,
    funded: 2_220_00,
    ownerCents: 1_110_00,
    daysLeft: 6,
  });

  await quotedListing({
    ownerId: owner.id,
    funderId: funder.id,
    orgId: org.id,
    productId: productByPeril.FL_HURRICANE,
    status: "LIVE",
    address: "330 Krome Ave",
    city: "Homestead",
    county: "Miami-Dade",
    state: "FL",
    zip: "33030",
    lat: 25.4687,
    lng: -80.4776,
    peril: "FL_HURRICANE",
    value: 310_000_00,
    mortgage: 150_000_00,
    lender: "Dade Farm Credit",
    premium: 4_100_00,
    coverage: 202_500_00,
    funded: 3_280_00,
    ownerCents: 615_00,
    daysLeft: 14,
  });

  const activeFl = await quotedListing({
    ownerId: owner2.id,
    funderId: funder.id,
    orgId: org.id,
    productId: productByPeril.FL_HURRICANE,
    status: "ACTIVE",
    address: "1800 Gulf Shore Blvd",
    city: "Naples",
    county: "Collier",
    state: "FL",
    zip: "34102",
    lat: 26.142,
    lng: -81.81,
    peril: "FL_HURRICANE",
    value: 1_250_000_00,
    mortgage: 620_000_00,
    lender: "Collier Mortgage",
    premium: 11_200_00,
    coverage: 837_000_00,
    funded: 11_200_00,
    ownerCents: 1_680_00,
    lenderNamed: true,
    bind: true,
    carrierId: carrier.id,
    policyNumber: "FS-FL-SEED002",
  });
  if (activeFl.policyId) {
    await prisma.triggerEventLog.create({
      data: {
        policyId: activeFl.policyId,
        source: "MOCK",
        payload: { mock: true, classification: "Cat 2", place: "Gulf of Mexico" },
        matched: false,
        confirmation: "NOT_MET",
        notes: "distanceKm=62.0 radiusKm=50 — below Cat 3 and outside radius",
      },
    });
  }

  await quotedListing({
    ownerId: owner2.id,
    funderId: funder2.id,
    orgId: org2.id,
    productId: productByPeril.CA_EARTHQUAKE,
    status: "TOPUP_LAPSED",
    address: "90 E Street",
    city: "Fresno",
    county: "Fresno",
    state: "CA",
    zip: "93706",
    lat: 36.7378,
    lng: -119.7871,
    peril: "CA_EARTHQUAKE",
    value: 410_000_00,
    mortgage: 180_000_00,
    lender: "Central Valley CU",
    premium: 2_900_00,
    coverage: 243_000_00,
    funded: 0,
    ownerCents: 0,
  });

  const pendingCa = await createProperty({
    ownerId: owner2.id,
    address: "1600 Vine Street",
    city: "Los Angeles",
    county: "Los Angeles",
    state: "CA",
    zip: "90028",
    lat: 34.1016,
    lng: -118.3267,
    peril: "CA_EARTHQUAKE",
    value: 1_800_000_00,
    mortgage: 700_000_00,
    lender: "Hollywood Federal",
  });
  await prisma.eligibilityCheck.create({
    data: {
      propertyId: pendingCa.id,
      bufferPassed: true,
      kycPassed: true,
      sameRiskCovered: false,
      inRiskZone: true,
      requiredCoverageCents: requiredCoverageCents(700_000_00),
      proposedCoverageCents: 1_800_000_00,
      notes: "Seed eligibility passed.",
    },
  });
  await filePackAndRequest(pendingCa.id, productByPeril.CA_EARTHQUAKE, owner2.id, "PENDING");

  console.log("Seeded mock closed-pilot book.");
  console.log("Password for all users:", PASSWORD);
  console.log("admin@ / owner@ / owner2@ / funder@ / funder2@ / carrier@ — all @fisure.local");
}

async function createProperty(input: {
  ownerId: string;
  address: string;
  city: string;
  county: string;
  state: "FL" | "CA";
  zip: string;
  lat: number;
  lng: number;
  peril: Peril;
  value: number;
  mortgage: number;
  lender: string;
}) {
  return prisma.property.create({
    data: {
      ownerId: input.ownerId,
      address: input.address,
      city: input.city,
      county: input.county,
      state: input.state,
      zip: input.zip,
      lat: input.lat,
      lng: input.lng,
      estimatedValueCents: input.value,
      peril: input.peril,
      mortgage: {
        create: {
          lenderName: input.lender,
          outstandingBalanceCents: input.mortgage,
        },
      },
    },
  });
}

async function filePackAndRequest(
  propertyId: string,
  productId: string,
  ownerId: string,
  status: "PENDING" | "ACCEPTED" | "DECLINED",
) {
  const key = safeKey(["properties", propertyId, "filepack.json"]);
  await putObject({
    key,
    body: Buffer.from(JSON.stringify({ propertyId, productId }, null, 2)),
    mimeType: "application/json",
  });
  await prisma.document.create({
    data: {
      kind: "FILE_PACK",
      filename: "submission-pack.json",
      storageKey: key,
      mimeType: "application/json",
      propertyId,
      uploadedById: ownerId,
    },
  });
  const request = await prisma.quoteRequest.create({
    data: {
      propertyId,
      carrierProductId: productId,
      filePackKey: key,
      status,
    },
  });
  return request;
}

async function quotedListing(input: {
  ownerId: string;
  funderId: string;
  orgId: string;
  productId: string;
  status: ListingStatus;
  address: string;
  city: string;
  county: string;
  state: "FL" | "CA";
  zip: string;
  lat: number;
  lng: number;
  peril: Peril;
  value: number;
  mortgage: number;
  lender: string;
  premium: number;
  coverage: number;
  funded: number;
  ownerCents: number;
  daysLeft?: number;
  lenderNamed?: boolean;
  bind?: boolean;
  carrierId?: string;
  topUpDays?: number;
  policyNumber?: string;
}) {
  const property = await createProperty(input);
  await prisma.eligibilityCheck.create({
    data: {
      propertyId: property.id,
      bufferPassed: true,
      kycPassed: true,
      sameRiskCovered: false,
      inRiskZone: true,
      requiredCoverageCents: requiredCoverageCents(input.mortgage),
      proposedCoverageCents: input.coverage,
      notes: "Seed eligibility passed.",
    },
  });
  const request = await filePackAndRequest(property.id, input.productId, input.ownerId, "ACCEPTED");
  const validUntil = new Date();
  validUntil.setDate(validUntil.getDate() + 40);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + (input.daysLeft ?? 20));
  const topUpEndsAt = input.topUpDays
    ? new Date(Date.now() + input.topUpDays * 24 * 60 * 60 * 1000)
    : null;

  const quote = await prisma.quote.create({
    data: {
      quoteRequestId: request.id,
      decision: "ACCEPTED",
      premiumCents: input.premium,
      coverageCents: input.coverage,
      validUntil,
      triggerJson: {
        text: PRODUCTS.find((p) => p.peril === input.peril)?.triggerDescription,
        radiusKm: radiusKmForPeril(input.peril),
      },
      payoutSchedule: PRODUCTS.find((p) => p.peril === input.peril)?.payoutSchedule,
    },
  });

  const listing = await prisma.listing.create({
    data: {
      propertyId: property.id,
      quoteId: quote.id,
      status: input.status,
      premiumTargetCents: input.premium,
      fundedCents: input.funded,
      ownerContributionCents: input.ownerCents,
      liveAt: input.status === "LIVE" || input.status === "ACTIVE" ? new Date() : null,
      expiresAt,
      topUpEndsAt,
      lenderNamedLossPayee: Boolean(input.lenderNamed || input.bind),
    },
  });

  if (input.ownerCents > 0) {
    await prisma.contribution.create({
      data: {
        listingId: listing.id,
        userId: input.ownerId,
        amountCents: input.ownerCents,
        status: "SUCCEEDED",
      },
    });
    await prisma.escrowLedger.create({
      data: {
        listingId: listing.id,
        type: "OWNER_PREMIUM",
        amountCents: input.ownerCents,
        partyUserId: input.ownerId,
        note: "simulated collection",
      },
    });
  }
  const funderCents = Math.max(input.funded - input.ownerCents, 0);
  if (funderCents > 0) {
    await prisma.contribution.create({
      data: {
        listingId: listing.id,
        userId: input.funderId,
        organizationId: input.orgId,
        amountCents: funderCents,
        status: "SUCCEEDED",
      },
    });
    await prisma.escrowLedger.create({
      data: {
        listingId: listing.id,
        type: "FUNDER_PREMIUM",
        amountCents: funderCents,
        partyUserId: input.funderId,
        note: "simulated collection",
      },
    });
  }

  let policyId: string | undefined;
  if (input.bind && input.carrierId) {
    const policy = await prisma.policy.create({
      data: {
        listingId: listing.id,
        carrierId: input.carrierId,
        policyNumber: input.policyNumber ?? `FS-SEED-${listing.id.slice(-6).toUpperCase()}`,
        lenderNamedLossPayee: true,
      },
    });
    policyId = policy.id;
    await prisma.triggerWatch.create({
      data: {
        policyId: policy.id,
        peril: input.peril,
        lat: input.lat,
        lng: input.lng,
        radiusKm: radiusKmForPeril(input.peril),
      },
    });
  }

  return { listingId: listing.id, policyId };
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
