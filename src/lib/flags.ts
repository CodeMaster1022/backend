function bool(value: string | undefined, fallback = false) {
  if (value == null) return fallback;
  return value === "true" || value === "1";
}

export const flags = {
  paymentsEnabled: bool(process.env.PAYMENTS_ENABLED),
  contributionsPublic: bool(process.env.CONTRIBUTIONS_PUBLIC),
  payoutsAutomated: bool(process.env.PAYOUTS_AUTOMATED),
  paymentsSimulate: bool(process.env.PAYMENTS_SIMULATE, true),
};

export function canCollectMoney() {
  return flags.paymentsEnabled || flags.paymentsSimulate;
}

export function canContributeInApp() {
  return flags.contributionsPublic ? "public" : "corporate-only";
}
