import crypto from "node:crypto";
import { prisma } from "./db.js";

export function sessionCookieOptions() {
  const days = Number(process.env.SESSION_DAYS ?? 7);
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: false,
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
