import { moduleLabel, roleNames } from "../lib/names.js";
export function repChangedPayload(e) {
    return {
        action: e.action,
        discordUserId: e.discordUserId,
        project: e.project.toLowerCase(),
        module: e.module,
        pod: e.pod,
        replacedDiscordUserId: e.replacedDiscordUserId ?? null,
        source: "discord",
        actorDiscordId: e.actorDiscordId,
        reason: e.reason ?? null,
        leadership: e.leadership,
        replacedLeadership: e.replacedLeadership ?? null,
    };
}
/**
 * Leads live only as Discord roles ("<Project> Team Lead", "<Project> M<m> P<n> Representative"),
 * so derive them from role names. All are matched without case (like rbac and findRoleCi); rep roles only for pods that exist.
 */
export function leadershipFromRoleNames(names, projects) {
    const lower = new Set(names.map((n) => n.toLowerCase()));
    const out = { teamLeadOf: [], coLeadOf: [], podRepOf: [] };
    for (const p of projects) {
        if (lower.has(roleNames.projectTeamLead(p).toLowerCase()))
            out.teamLeadOf.push(p.key);
        if (lower.has(roleNames.projectCoLead(p).toLowerCase()))
            out.coLeadOf.push(p.key);
        for (let m = 1; m <= p.modules; m++)
            for (let pd = 1; pd <= p.podsPerModule; pd++)
                if (lower.has(roleNames.podRep(p, m, pd).toLowerCase()))
                    out.podRepOf.push({ project: p.key.toLowerCase(), module: m, pod: pd });
    }
    out.podRepOf.sort((a, b) => a.project.localeCompare(b.project) || a.module - b.module || a.pod - b.pod);
    return out;
}
/**
 * Leadership right after a role change. discord.js does not update `member.roles.cache` synchronously after
 * roles.add / roles.remove, so start from the cached names, add the names just added and drop the ones just
 * removed (without case).
 */
export function leadershipAfterChange(cached, added, removed, projects) {
    const gone = new Set(removed.map((n) => n.toLowerCase()));
    const names = [...cached, ...added].filter((n) => !gone.has(n.toLowerCase()));
    return leadershipFromRoleNames(names, projects);
}
/**
 * Member.project stores the project's display name (onboarding writes p.name),
 * but EMS keys projects by `key`. Accept either, return the key (null if the
 * project no longer exists in org.json). Case and surrounding whitespace are ignored.
 */
export function projectKeyOf(value, projects) {
    if (!value)
        return null;
    const exact = projects.find((p) => p.key === value || p.name === value);
    if (exact)
        return exact.key;
    // Hand-edited rows and older onboarding wrote names with stray case/whitespace.
    const v = normProject(value);
    if (!v)
        return null;
    return projects.find((p) => normProject(p.key) === v || normProject(p.name) === v)?.key ?? null;
}
/** Trimmed, lower-case form used to compare project keys and names. */
export function normProject(value) {
    return value.trim().toLowerCase();
}
export function memberDto(m, leadership) {
    return {
        id: m.id,
        fullName: m.fullName ?? m.displayName ?? m.tag ?? m.id,
        tag: m.tag,
        batch: m.batch,
        project: m.project,
        module: m.module,
        pod: m.pod,
        status: m.status,
        verificationStatus: m.verificationStatus,
        updatedAt: m.updatedAt.toISOString(),
        leadership,
    };
}
export function orgDto(projects) {
    return {
        projects: projects.map((p) => ({
            key: p.key,
            name: p.name,
            active: p.active,
            modules: Array.from({ length: p.modules }, (_, i) => ({
                num: i + 1,
                name: moduleLabel(p, i + 1),
                pods: Array.from({ length: p.podsPerModule }, (_, j) => j + 1),
            })),
        })),
    };
}
//# sourceMappingURL=integrationPayloads.js.map