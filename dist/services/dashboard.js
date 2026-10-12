import { prisma } from "../core/db.js";
import { activeProjects, findProject } from "../config/loader.js";
import { roleNames } from "../lib/names.js";
import { shiftDayKey, tzDateKey } from "../lib/time.js";
import { liveUserIds, pendingOpenSeconds } from "./attendance.js";
/** Day buckets follow the ORG timezone, matching how attendance is credited. */
function dayKey(d) {
    return tzDateKey(d);
}
function roleMemberCount(guild, name) {
    const role = guild.roles.cache.find((r) => r.name === name);
    return role ? role.members.size : 0;
}
export async function buildOverview(guild) {
    const now = new Date();
    const today = dayKey(now);
    const weekAgo = shiftDayKey(today, -6);
    const projects = activeProjects();
    const perProject = projects.map((p) => ({
        name: p.name,
        count: roleMemberCount(guild, roleNames.project(p)),
    }));
    const [open, claimed, closed, todayRows, weekAgg, attendedRows, live, pending, internIds] = await Promise.all([
        prisma.ticket.count({ where: { guildId: guild.id, status: "open" } }),
        prisma.ticket.count({ where: { guildId: guild.id, status: "claimed" } }),
        prisma.ticket.count({ where: { guildId: guild.id, status: "closed" } }),
        prisma.attendance.findMany({
            where: { guildId: guild.id, day: today, seconds: { gt: 0 } },
            select: { userId: true },
        }),
        prisma.attendance.aggregate({
            where: { guildId: guild.id, day: { gte: weekAgo } },
            _sum: { seconds: true },
        }),
        prisma.attendance.findMany({
            where: { guildId: guild.id, day: { gte: weekAgo }, seconds: { gt: 0 } },
            select: { userId: true },
            distinct: ["userId"],
        }),
        liveUserIds(guild.id),
        pendingOpenSeconds(guild.id),
        Promise.resolve(internRoleMemberIds(guild)),
    ]);
    // Anyone connected RIGHT NOW is present even if their first checkpoint hasn't
    // landed yet — without this, someone who just joined reads as inactive.
    const activeSet = new Set(todayRows.map((r) => r.userId));
    for (const id of live)
        activeSet.add(id);
    const attended = new Set(attendedRows.map((r) => r.userId));
    for (const id of live)
        attended.add(id);
    const inactiveCount = internIds.filter((id) => !attended.has(id)).length;
    let pendingSeconds = 0;
    for (const perDay of pending.values()) {
        for (const [day, secs] of perDay)
            if (day >= weekAgo)
                pendingSeconds += secs;
    }
    return {
        activeToday: activeSet.size,
        liveNow: live.size,
        totalInterns: roleMemberCount(guild, roleNames.intern()),
        perProject,
        teamLeads: roleMemberCount(guild, "Team Lead"),
        coLeads: roleMemberCount(guild, "Co-Lead"),
        activeProjects: projects.length,
        totalModules: projects.reduce((a, p) => a + p.modules, 0),
        totalPods: projects.reduce((a, p) => a + p.modules * p.podsPerModule, 0),
        tickets: { open, claimed, closed },
        weeklyVoiceSeconds: (weekAgg._sum.seconds ?? 0) + pendingSeconds,
        inactiveCount,
    };
}
function internRoleMemberIds(guild) {
    const role = guild.roles.cache.find((r) => r.name === roleNames.intern());
    return role ? Array.from(role.members.keys()) : [];
}
export function buildProjectBreakdown(guild, projectKey) {
    const p = findProject(projectKey);
    if (!p)
        return null;
    const modules = Array.from({ length: p.modules }, (_, i) => {
        const m = i + 1;
        const pods = Array.from({ length: p.podsPerModule }, (_, j) => {
            const pd = j + 1;
            return { pod: pd, count: roleMemberCount(guild, roleNames.pod(p, m, pd)) };
        });
        return { module: m, count: roleMemberCount(guild, roleNames.module(p, m)), pods };
    });
    return {
        project: p,
        projectCount: roleMemberCount(guild, roleNames.project(p)),
        modules,
    };
}
export async function listInactiveInterns(guild) {
    const weekAgo = shiftDayKey(dayKey(new Date()), -6);
    const [attendedRows, live] = await Promise.all([
        prisma.attendance.findMany({
            where: { guildId: guild.id, day: { gte: weekAgo }, seconds: { gt: 0 } },
            select: { userId: true },
            distinct: ["userId"],
        }),
        liveUserIds(guild.id),
    ]);
    const attended = new Set(attendedRows.map((r) => r.userId));
    // Currently-connected members are active by definition, even if their first
    // checkpoint for the week hasn't been written yet.
    for (const id of live)
        attended.add(id);
    return internRoleMemberIds(guild).filter((id) => !attended.has(id));
}
//# sourceMappingURL=dashboard.js.map