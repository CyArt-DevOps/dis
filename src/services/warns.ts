import { prisma } from "../core/db.js";

export interface WarnInput {
  guildId: string;
  userId: string;
  modId: string;
  reason: string;
}

export async function addWarn(w: WarnInput) {
  return prisma.warn.create({ data: w });
}

export async function listWarns(guildId: string, userId: string) {
  return prisma.warn.findMany({
    where: { guildId, userId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Deletes the member's warns except EMS-mirrored ones (source "ems"): those are
 * withdrawn in EMS, which revokes the mirror. `kept` counts the ones left.
 */
export async function clearWarns(guildId: string, userId: string): Promise<{ cleared: number; kept: number }> {
  const res = await prisma.warn.deleteMany({ where: { guildId, userId, NOT: { source: "ems" } } });
  const kept = await prisma.warn.count({ where: { guildId, userId, source: "ems" } });
  return { cleared: res.count, kept };
}
