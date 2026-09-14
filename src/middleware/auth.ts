import type { NextFunction, Request, Response } from "express";
import type { Role } from "@prisma/client";
import { prisma } from "../lib/db.js";
import type { AuthedUser } from "../lib/serialize.js";

export const COOKIE = "fisure_session";

declare global {
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

export async function loadSession(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE] as string | undefined;
  if (!token) return next();
  const session = await prisma.session.findUnique({
    where: { sessionToken: token },
    include: {
      user: {
        include: { memberships: { include: { organization: true } } },
      },
    },
  });
  if (session && session.expires > new Date()) {
    req.user = session.user;
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: "Sign in required." });
    return;
  }
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "Sign in required." });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: "Not allowed for this role." });
      return;
    }
    next();
  };
}

export function requireKyc(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: "Sign in required." });
    return;
  }
  if (req.user.kycStatus !== "PASSED") {
    res.status(403).json({ error: "Identity check must pass before this action." });
    return;
  }
  next();
}

export function wrap(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}
