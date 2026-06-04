import { PrismaClient } from "@prisma/client";

/**
 * Single Prisma instance shared across the app. Hot-reload friendly:
 * keeps the connection alive across tsx watch restarts.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ log: ["warn", "error"] });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
