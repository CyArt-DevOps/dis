import { prisma } from "../core/db.js";
export async function addWarn(w) {
    return prisma.warn.create({ data: w });
}
export async function listWarns(guildId, userId) {
    return prisma.warn.findMany({
        where: { guildId, userId, status: { notIn: ["revoked", "dismissed"] } },
        orderBy: { createdAt: "desc" },
    });
}
/**
 * Clears the member's warns except EMS-mirrored ones (source "ems"): those are
 * withdrawn in EMS, which revokes the mirror. `kept` counts the ones left. Issued
 * warns are marked revoked rather than deleted, so EMS's pull sees the withdrawal.
 */
export async function clearWarns(guildId, userId) {
    const active = { guildId, userId, NOT: { source: "ems" } };
    const drafts = await prisma.warn.deleteMany({ where: { ...active, status: "proposed" } });
    const issued = await prisma.warn.updateMany({
        where: { ...active, status: { notIn: ["revoked", "dismissed"] } },
        data: { status: "revoked", reviewedBy: "clearwarns" },
    });
    const kept = await prisma.warn.count({ where: { guildId, userId, source: "ems", status: { notIn: ["revoked", "dismissed"] } } });
    return { cleared: drafts.count + issued.count, kept };
}
//# sourceMappingURL=warns.js.map