import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// Prisma's interactive-transaction default is 5s, tuned for a local database.
// Against a remote MongoDB Atlas cluster, real network round-trips (especially
// for transactions that loop over a variable number of documents, e.g. refunding
// every contribution on every affected listing) can exceed that under normal
// latency, not just under load. Atlas is already a replica set, so transactions
// work — they just need more headroom than SQLite ever required.
export const TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 };
