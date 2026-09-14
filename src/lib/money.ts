export function usd(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export function bps(numerator: number, denominator: number) {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10_000);
}

export function requiredCoverageCents(mortgageCents: number) {
  return Math.ceil(mortgageCents * 1.35);
}

export function bufferPassed(coverageCents: number, mortgageCents: number) {
  return coverageCents >= requiredCoverageCents(mortgageCents);
}

export function minimumPayableCents(
  coverageCents: number,
  payoutSchedule: unknown,
): number {
  if (!payoutSchedule || typeof payoutSchedule !== "object") {
    return coverageCents;
  }
  const record = payoutSchedule as { bands?: Array<{ pct?: number; cents?: number }> };
  const bands = record.bands;
  if (!bands?.length) return coverageCents;
  const values = bands.map((band) => {
    if (typeof band.cents === "number") return band.cents;
    if (typeof band.pct === "number") return Math.round((coverageCents * band.pct) / 100);
    return coverageCents;
  });
  return Math.min(...values);
}

export function platformFeeBps(premiumCents: number) {
  if (premiumCents <= 100_000) return 2000;
  if (premiumCents < 800_000) return 1500;
  return 1200;
}

export function platformFeeCents(premiumCents: number) {
  return Math.round((premiumCents * platformFeeBps(premiumCents)) / 10_000);
}

export function listingWindow(params: {
  now?: Date;
  ownerRequestedDays: number;
  quoteValidUntil: Date;
  topUpDays?: number;
}) {
  const now = params.now ?? new Date();
  const topUpDays = params.topUpDays ?? 7;
  const ownerEnd = new Date(now);
  ownerEnd.setDate(ownerEnd.getDate() + params.ownerRequestedDays);
  const quoteBound = new Date(params.quoteValidUntil);
  quoteBound.setDate(quoteBound.getDate() - topUpDays);
  return ownerEnd < quoteBound ? ownerEnd : quoteBound;
}

export function waterfall(params: {
  grossCents: number;
  mortgageCents: number;
  ownerContributionBps: number;
}) {
  const lenderCents = Math.min(Math.max(params.mortgageCents, 0), params.grossCents);
  const netCents = params.grossCents - lenderCents;
  const ownerCents = Math.round((netCents * params.ownerContributionBps) / 10_000);
  const funderPoolCents = netCents - ownerCents;
  return { lenderCents, netCents, ownerCents, funderPoolCents };
}

export function dollarsToCents(value: string | number) {
  const n = typeof value === "number" ? value : Number(String(value).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}
