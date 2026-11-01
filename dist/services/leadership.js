import { findProject, org } from "../config/loader.js";
import { podRepRoleNames, roleNames } from "../lib/names.js";
import { logEmbed, postLog } from "../lib/log.js";
import { leadershipFromRoleNames } from "./integrationPayloads.js";
function findRole(guild, name) {
    return guild.roles.cache.find((r) => r.name === name);
}
export async function assignLead(args) {
    const p = findProject(args.projectKey);
    if (!p)
        throw new Error(`Unknown project ${args.projectKey}`);
    // Base role (Discord perms + command visibility), per-project scoping role,
    // and the project membership role.
    const roles = [
        args.kind,
        args.kind === "Team Lead"
            ? roleNames.projectTeamLead(p)
            : roleNames.projectCoLead(p),
        roleNames.project(p),
    ];
    if (args.kind === "Co-Lead") {
        if (!args.moduleNum || !args.podNum)
            throw new Error("Co-Lead requires module and pod");
        roles.push(roleNames.module(p, args.moduleNum));
        roles.push(roleNames.pod(p, args.moduleNum, args.podNum));
    }
    const applied = [];
    for (const name of roles) {
        const r = findRole(args.member.guild, name);
        if (r && !args.member.roles.cache.has(r.id)) {
            await args.member.roles.add(r, `${args.actor.user.tag} assigned ${args.kind}`);
        }
        if (r)
            applied.push(name);
    }
    await postLog(args.member.guild, "audit", logEmbed(`${args.kind} assigned`, 0xfaa61a)
        .setDescription(`<@${args.member.id}> → ${p.name}` +
        (args.kind === "Co-Lead" ? ` M${args.moduleNum} P${args.podNum}` : ""))
        .addFields({ name: "By", value: `<@${args.actor.id}>` }));
    return applied;
}
export async function removeLead(member, kind, actor) {
    // Strip the base role and every per-project scoping role of this kind
    // (e.g. "Team Lead" and "AI SIEM Team Lead"). Project membership is kept.
    const toRemove = member.roles.cache.filter((r) => r.name === kind || r.name.endsWith(` ${kind}`));
    for (const r of toRemove.values()) {
        await member.roles.remove(r, `${actor.user.tag} removed ${kind}`).catch(() => { });
    }
    await postLog(member.guild, "audit", logEmbed(`${kind} removed`, 0xed4245)
        .setDescription(`<@${member.id}>`)
        .addFields({ name: "By", value: `<@${actor.id}>` }));
}
export function listLeads(guild, kind) {
    const r = findRole(guild, kind);
    if (!r)
        return [];
    return Array.from(r.members.values());
}
const actorTag = (a) => ("emsName" in a ? `${a.emsName} (EMS)` : a.user.tag);
const actorMention = (a) => ("emsName" in a ? `${a.emsName} (EMS)` : `<@${a.id}>`);
/** The pod already has a representative and the caller did not ask to replace them. */
export class PodHasRepError extends Error {
    holders;
    constructor(holders, podLabel) {
        super(`${podLabel} already has a representative.`);
        this.holders = holders;
        this.name = "PodHasRepError";
    }
}
/** Rep roles are matched without case (a hand-renamed "cybreach m1 p2 representative" still counts). */
function findRoleCi(guild, name) {
    const lower = name.toLowerCase();
    return guild.roles.cache.find((r) => r.name.toLowerCase() === lower);
}
/** Members other than `exceptId` holding this pod's rep role (from the member cache). [] when the role is missing. */
export function podRepHolders(guild, projectKey, moduleNum, podNum, exceptId) {
    const p = findProject(projectKey);
    if (!p)
        return [];
    const role = findRoleCi(guild, roleNames.podRep(p, moduleNum, podNum));
    if (!role)
        return [];
    return [...guild.members.cache.values()].filter((m) => m.id !== exceptId && m.roles.cache.has(role.id));
}
/**
 * Adds the rep role plus the project / module / pod membership roles, so the rep is in the pod.
 * Throws before changing anything if the rep role itself does not exist yet, or (one rep per pod) if someone else
 * holds it and `replace` is not set; with `replace` the old holders lose the rep role last, so a failed add never
 * leaves the pod without a rep.
 */
export async function assignPodRep(args) {
    const p = findProject(args.projectKey);
    if (!p || args.moduleNum < 1 || args.moduleNum > p.modules || args.podNum < 1 || args.podNum > p.podsPerModule)
        throw new Error(`${p ? p.name : args.projectKey} has no pod M${args.moduleNum} P${args.podNum}`);
    const guild = args.member.guild;
    const repRole = findRoleCi(guild, roleNames.podRep(p, args.moduleNum, args.podNum));
    if (!repRole)
        throw new Error("Rep role missing — run /setup");
    const holders = podRepHolders(guild, p.key, args.moduleNum, args.podNum, args.member.id);
    if (holders.length && !args.replace)
        throw new PodHasRepError(holders, `${p.name} M${args.moduleNum} P${args.podNum}`);
    const roles = [repRole];
    for (const name of [
        roleNames.project(p),
        roleNames.module(p, args.moduleNum),
        roleNames.pod(p, args.moduleNum, args.podNum),
    ]) {
        const r = findRole(guild, name);
        if (r)
            roles.push(r);
    }
    const applied = [];
    for (const r of roles) {
        if (!args.member.roles.cache.has(r.id)) {
            await args.member.roles.add(r, `${actorTag(args.actor)} assigned Pod Representative`);
        }
        applied.push(r.name);
    }
    for (const h of holders)
        await h.roles.remove(repRole, `${actorTag(args.actor)} replaced Pod Representative`);
    const embed = logEmbed("Pod Representative assigned", 0x1abc9c)
        .setDescription(`<@${args.member.id}> → ${p.name} M${args.moduleNum} P${args.podNum}`)
        .addFields({ name: "By", value: actorMention(args.actor) });
    if (holders.length)
        embed.addFields({ name: "Replaced", value: holders.map((h) => `<@${h.id}>`).join(", ") });
    await postLog(guild, "audit", embed);
    return applied;
}
/**
 * Which rep role names a /rep remove targets: project + module + pod -> that pod; project +
 * module -> that module's; project -> that project's; nothing -> every configured rep role.
 * Module or pod without a project, or a pod without a module, is rejected.
 */
function podRepTargets(args) {
    if (!args.projectKey) {
        if (args.moduleNum !== undefined || args.podNum !== undefined)
            throw new Error("Give a project together with module / pod.");
        return org.projects.flatMap((p) => podRepRoleNames(p));
    }
    const p = findProject(args.projectKey);
    if (!p)
        throw new Error(`Unknown project ${args.projectKey}`);
    if (args.podNum !== undefined && args.moduleNum === undefined)
        throw new Error("Give a module together with the pod.");
    if (args.moduleNum !== undefined && args.podNum !== undefined)
        return [roleNames.podRep(p, args.moduleNum, args.podNum)];
    if (args.moduleNum !== undefined) {
        const out = [];
        for (let pd = 1; pd <= p.podsPerModule; pd++)
            out.push(roleNames.podRep(p, args.moduleNum, pd));
        return out;
    }
    return podRepRoleNames(p);
}
/**
 * Removes the targeted rep roles (see podRepTargets) the member holds. Only names the bot
 * generates are touched, never an arbitrary "* Representative" role. Membership roles stay.
 * Audits only when something was actually removed.
 */
export async function removePodRep(args) {
    const targets = new Set(podRepTargets(args).map((n) => n.toLowerCase()));
    const removed = [];
    const failed = [];
    const held = [...args.member.roles.cache.values()].filter((r) => targets.has(r.name.toLowerCase()));
    for (const r of held) {
        try {
            await args.member.roles.remove(r, `${actorTag(args.actor)} removed Pod Representative`);
            removed.push(r.name);
        }
        catch {
            failed.push(r.name);
        }
    }
    if (removed.length > 0) {
        const embed = logEmbed("Pod Representative removed", 0xed4245)
            .setDescription(`<@${args.member.id}> (${removed.join(", ")})`)
            .addFields({ name: "By", value: actorMention(args.actor) });
        if (args.reason)
            embed.addFields({ name: "Reason", value: args.reason.slice(0, 1000) });
        await postLog(args.member.guild, "audit", embed);
    }
    return { removed, failed };
}
/** Reps per pod from the member cache (optionally one project). */
export function listPodReps(guild, projectKey) {
    const want = projectKey?.toLowerCase();
    const out = [];
    for (const m of guild.members.cache.values()) {
        const names = [...m.roles.cache.values()].map((r) => r.name);
        for (const ref of leadershipFromRoleNames(names, org.projects).podRepOf) {
            if (!want || ref.project === want)
                out.push({ memberId: m.id, ...ref });
        }
    }
    return out;
}
//# sourceMappingURL=leadership.js.map