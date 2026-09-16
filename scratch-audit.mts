import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const properties = await prisma.property.findMany({ select: { id: true, address: true, city: true, ownerId: true } });
const suspicious = properties.filter(p => /test|regress/i.test(p.address) || /test|regress/i.test(p.city));
console.log("suspicious properties:", suspicious);

const carriers = await prisma.carrier.findMany({ select: { id: true, name: true, slug: true } });
console.log("all carriers:", carriers);

const totalProps = await prisma.property.count();
const totalListings = await prisma.listing.count();
console.log({ totalProps, totalListings });

await prisma.$disconnect();
