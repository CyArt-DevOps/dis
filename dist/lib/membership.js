import { org } from "../config/loader.js";
import { prisma } from "../core/db.js";
import { roleNames } from "./names.js";
import { logger } from "../core/logger.js";
/**
 * Derive a member's batch / project / module / pod from the roles they CURRENTLY
 * hold in Discord — the authoritative source, since Managers change membership by
 * editing roles directly (which the DB profile does not otherwise track).
 *
 * Role names are deterministic (see lib/names.ts), so we reverse them here. If a
 * member somehow holds two project roles, the first in config order wins and a
 * warning is logged — single-membership is expected.
 */
export function deriveMembership(member) {
    const held = new Set(member.roles.cache.map((r) => r.name));
    const batch = org.batches.find((b) => held.has(b));
    const projectMatches = org.projects.filter((p) => held.has(p.name));
    if (projectMatches.length > 1) {
        logger.warn({ user: member.id, projects: projectMatches.map((p) => p.name) }, "Member holds multiple project roles — using the first; clean up their roles");
    }
    const project = projectMatches[0];
    let moduleNum;
    let podNum;
    if (project) {
        for (let m = 1; m <= project.modules; m++) {
            if (held.has(roleNames.module(project, m))) {
                moduleNum = m;
                for (let pd = 1; pd <= project.podsPerModule; pd++) {
                    if (held.has(roleNames.pod(project, m, pd))) {
                        podNum = pd;
                        break;
                    }
                }
                break;
            }
        }
    }
    return { batch, project, moduleNum, podNum };
}
/**
 * Reconcile a member's stored DB profile (batch/project/module/pod) with their
 * current Discord roles. Only touches verified members (those holding the Intern
 * role) and only when something actually differs. Returns true if a write
 * occurred. Does NOT create rows for unverified members.
 */
export async function syncMemberProfileFromRoles(member) {
    const verified = member.roles.cache.some((r) => r.name === roleNames.intern());
    if (!verified)
        return false;
    const { batch, project, moduleNum, podNum } = deriveMembership(member);
    // No project role → nothing reliable to sync; leave the record untouched.
    if (!project)
        return false;
    const existing = await prisma.member.findUnique({ where: { id: member.id } });
    const next = {
        batch: batch ?? existing?.batch ?? null,
        project: project.name,
        module: moduleNum ?? null,
        pod: podNum ?? null,
    };
    if (existing &&
        existing.project === next.project &&
        existing.batch === next.batch &&
        existing.module === next.module &&
        existing.pod === next.pod) {
        return false; // already in sync
    }
    await prisma.member.upsert({
        where: { id: member.id },
        create: {
            id: member.id,
            guildId: member.guild.id,
            tag: member.user.tag,
            displayName: member.displayName,
            fullName: existing?.fullName ?? member.displayName,
            registrationDate: existing?.registrationDate ?? new Date(),
            verificationStatus: "verified",
            ...next,
        },
        update: next,
    });
    logger.info({
        user: member.id,
        from: existing
            ? { project: existing.project, module: existing.module, pod: existing.pod }
            : null,
        to: { project: next.project, module: next.module, pod: next.pod },
    }, "Synced member profile from roles");
    return true;
}
//# sourceMappingURL=membership.js.map