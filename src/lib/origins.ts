// UI_ORIGIN accepts a comma-separated list, so a deployed frontend (e.g. a
// Vercel URL) and localhost can both be allowed at once during a staged rollout.
export const allowedOrigins = (process.env.UI_ORIGIN ?? "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean)
  .concat(["http://127.0.0.1:3000"]);

export function isAllowedReturnUrl(url: string): boolean {
  try {
    return allowedOrigins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

export function firstAllowedOrigin(): string {
  return allowedOrigins[0] ?? "http://localhost:3000";
}
