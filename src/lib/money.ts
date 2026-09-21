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
  // Integer arithmetic, not `* 1.35`: floating point makes 24000000 * 1.35
  // land on 32400000.000000004, so Math.ceil added a phantom cent and the
  // displayed minimum was rejected when typed back.
  return Math.ceil((mortgageCents * 135) / 100);
}

export function bufferPassed(coverageCents: number, mortgageCents: number) {
  return coverageCents >= requiredCoverageCents(mortgageCents);
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
