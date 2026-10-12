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

export async function clearWarns(guildId: string, userId: string): Promise<number> {
  const res = await prisma.warn.deleteMany({ where: { guildId, userId } });
  return res.count;
}
