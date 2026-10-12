import { prisma } from "../core/db.js";
export async function addWarn(w) {
    return prisma.warn.create({ data: w });
}
export async function listWarns(guildId, userId) {
    return prisma.warn.findMany({
        where: { guildId, userId },
        orderBy: { createdAt: "desc" },
    });
}
export async function clearWarns(guildId, userId) {
    const res = await prisma.warn.deleteMany({ where: { guildId, userId } });
    return res.count;
}
//# sourceMappingURL=warns.js.map