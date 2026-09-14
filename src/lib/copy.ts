export const DISCLOSURE_VERSION = "v1-pilot-2026";

export const DISCLOSURE_TEXT = `FiSure is a marketplace operator, not an insurer, underwriter, or guarantor.

A contribution is not an investment, not a deposit, not an insurance product, and not FDIC-insured. It carries a risk of total loss.

Payout is contingent solely on a qualifying parametric trigger during the active policy period. If no qualifying trigger occurs, the contribution is consumed as insurance premium and is not refunded.

If a trigger is confirmed and the carrier pays, proceeds follow a published waterfall: (1) mortgage lender in full as loss payee, if any; (2) the property owner, in proportion to their premium contribution, of the net remainder — not rebuild cost; (3) contributors, pro-rata, of what remains.

Parametric cover is paid on a public index. The trigger may fire with little damage, or significant damage may occur without the trigger firing.

Historical event frequency, where shown, is indicative third-party data, not a prediction.`;

export const BANNED_COPY = [
  "invest in a property",
  "earn a return",
  "expected yield",
  "roi",
  "investment portfolio",
  "profit from claims",
  "high-return catastrophe",
];

export function assertSafeCopy(text: string) {
  const lower = text.toLowerCase();
  const hit = BANNED_COPY.find((phrase) => lower.includes(phrase));
  if (hit) {
    throw new Error(`Copy uses banned investment framing: "${hit}"`);
  }
}
