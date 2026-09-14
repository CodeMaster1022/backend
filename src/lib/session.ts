import crypto from "node:crypto";
import { prisma } from "./db.js";

// Same-origin local dev (site and server both on localhost) works fine with
// sameSite: "lax", secure: false. Once the frontend and backend are deployed to
// different domains (e.g. a Vercel frontend calling a VPS backend), a "lax"
// cookie is never sent on cross-site API calls at all — login appears to
// succeed (Set-Cookie arrives) but every request right after comes back
// unauthenticated. Cross-site cookies require sameSite: "none", which browsers
// only honor when secure: true — which in turn requires the backend to actually
// be served over HTTPS. Set COOKIE_CROSS_SITE=true once that's in place.
const CROSS_SITE = process.env.COOKIE_CROSS_SITE === "true";

export function sessionCookieOptions() {
  const days = Number(process.env.SESSION_DAYS ?? 7);
  return {
    httpOnly: true,
    sameSite: (CROSS_SITE ? "none" : "lax") as "none" | "lax",
    secure: CROSS_SITE,
    path: "/",
    maxAge: days * 24 * 60 * 60 * 1000,
  };
}

export async function issueSession(userId: string) {
  const sessionToken = crypto.randomBytes(32).toString("hex");
  const expires = new Date();
  expires.setDate(expires.getDate() + Number(process.env.SESSION_DAYS ?? 7));
  await prisma.session.create({ data: { sessionToken, userId, expires } });
  return sessionToken;
}
