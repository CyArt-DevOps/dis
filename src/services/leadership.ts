import { Guild, GuildMember, Role } from "discord.js";
import { findProject, org } from "../config/loader.js";
import { podRepRoleNames, roleNames } from "../lib/names.js";
import { logEmbed, postLog } from "../lib/log.js";
import { leadershipFromRoleNames } from "./integrationPayloads.js";

export type LeadKind = "Team Lead" | "Co-Lead";

function findRole(guild: Guild, name: string): Role | undefined {
  return guild.roles.cache.find((r) => r.name === name);
}

export interface LeadAssignArgs {
  kind: LeadKind;
  member: GuildMember;
  projectKey: string;
  moduleNum?: number;
  podNum?: number;
  actor: GuildMember;
}

export async function assignLead(args: LeadAssignArgs): Promise<string[]> {
  const p = findProject(args.projectKey);
  if (!p) throw new Error(`Unknown project ${args.projectKey}`);

  // Base role (Discord perms + command visibility), per-project scoping role,
  // and the project membership role.
  const roles: string[] = [
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

  const applied: string[] = [];
  for (const name of roles) {
    const r = findRole(args.member.guild, name);
    if (r && !args.member.roles.cache.has(r.id)) {
      await args.member.roles.add(r, `${args.actor.user.tag} assigned ${args.kind}`);
    }
    if (r) applied.push(name);
  }

  await postLog(
    args.member.guild,
    "audit",
    logEmbed(`${args.kind} assigned`, 0xfaa61a)
      .setDescription(
        `<@${args.member.id}> → ${p.name}` +
          (args.kind === "Co-Lead" ? ` M${args.moduleNum} P${args.podNum}` : "")
      )
      .addFields({ name: "By", value: `<@${args.actor.id}>` })
  );

  return applied;
}

export async function removeLead(
  member: GuildMember,
  kind: LeadKind,
  actor: GuildMember
): Promise<void> {
  // Strip the base role and every per-project scoping role of this kind
  // (e.g. "Team Lead" and "AI SIEM Team Lead"). Project membership is kept.
  const toRemove = member.roles.cache.filter(
    (r) => r.name === kind || r.name.endsWith(` ${kind}`)
  );
  for (const r of toRemove.values()) {
    await member.roles.remove(r, `${actor.user.tag} removed ${kind}`).catch(() => {});
  }
  await postLog(
    member.guild,
    "audit",
    logEmbed(`${kind} removed`, 0xed4245)
      .setDescription(`<@${member.id}>`)
      .addFields({ name: "By", value: `<@${actor.id}>` })
  );
}

export function listLeads(guild: Guild, kind: LeadKind): GuildMember[] {
  const r = findRole(guild, kind);
  if (!r) return [];
  return Array.from(r.members.values());
}

// ---- Pod Representatives (Phase 6) -----------------------------------------
// "<Project> M<m> P<n> Representative": no server perms, no org-wide base role.
// EMS reads the role through /api/v1/members and grants the pod powers there.

export interface PodRepArgs {
  member: GuildMember;
  projectKey: string;
  moduleNum: number;
  podNum: number;
  actor: GuildMember;
}

/** Rep roles are matched without case (a hand-renamed "cybreach m1 p2 representative" still counts). */
function findRoleCi(guild: Guild, name: string): Role | undefined {
  const lower = name.toLowerCase();
  return guild.roles.cache.find((r) => r.name.toLowerCase() === lower);
}

/**
 * Adds the rep role plus the project / module / pod membership roles, so the rep is in the pod.
 * Throws before changing anything if the rep role itself does not exist yet.
 */
export async function assignPodRep(args: PodRepArgs): Promise<string[]> {
  const p = findProject(args.projectKey);
  if (!p || args.moduleNum < 1 || args.moduleNum > p.modules || args.podNum < 1 || args.podNum > p.podsPerModule)
    throw new Error(`${p ? p.name : args.projectKey} has no pod M${args.moduleNum} P${args.podNum}`);
  const guild = args.member.guild;
  const repRole = findRoleCi(guild, roleNames.podRep(p, args.moduleNum, args.podNum));
  if (!repRole) throw new Error("Rep role missing — run /setup");
  const roles: Role[] = [repRole];
  for (const name of [
    roleNames.project(p),
    roleNames.module(p, args.moduleNum),
    roleNames.pod(p, args.moduleNum, args.podNum),
  ]) {
    const r = findRole(guild, name);
    if (r) roles.push(r);
  }
  const applied: string[] = [];
  for (const r of roles) {
    if (!args.member.roles.cache.has(r.id)) {
      await args.member.roles.add(r, `${args.actor.user.tag} assigned Pod Representative`);
    }
    applied.push(r.name);
  }
  await postLog(
    guild,
    "audit",
    logEmbed("Pod Representative assigned", 0x1abc9c)
      .setDescription(`<@${args.member.id}> → ${p.name} M${args.moduleNum} P${args.podNum}`)
      .addFields({ name: "By", value: `<@${args.actor.id}>` })
  );
  return applied;
}

export interface PodRepRemoveArgs {
  member: GuildMember;
  actor: GuildMember;
  projectKey?: string;
  moduleNum?: number;
  podNum?: number;
}

/**
 * Which rep role names a /rep remove targets: project + module + pod -> that pod; project +
 * module -> that module's; project -> that project's; nothing -> every configured rep role.
 * Module or pod without a project, or a pod without a module, is rejected.
 */
function podRepTargets(args: PodRepRemoveArgs): string[] {
  if (!args.projectKey) {
    if (args.moduleNum !== undefined || args.podNum !== undefined)
      throw new Error("Give a project together with module / pod.");
    return org.projects.flatMap((p) => podRepRoleNames(p));
  }
  const p = findProject(args.projectKey);
  if (!p) throw new Error(`Unknown project ${args.projectKey}`);
  if (args.podNum !== undefined && args.moduleNum === undefined)
    throw new Error("Give a module together with the pod.");
  if (args.moduleNum !== undefined && args.podNum !== undefined)
    return [roleNames.podRep(p, args.moduleNum, args.podNum)];
  if (args.moduleNum !== undefined) {
    const out: string[] = [];
    for (let pd = 1; pd <= p.podsPerModule; pd++) out.push(roleNames.podRep(p, args.moduleNum, pd));
    return out;
  }
  return podRepRoleNames(p);
}

/**
 * Removes the targeted rep roles (see podRepTargets) the member holds. Only names the bot
 * generates are touched, never an arbitrary "* Representative" role. Membership roles stay.
 * Audits only when something was actually removed.
 */
export async function removePodRep(args: PodRepRemoveArgs): Promise<{ removed: string[]; failed: string[] }> {
  const targets = new Set(podRepTargets(args).map((n) => n.toLowerCase()));
  const removed: string[] = [];
  const failed: string[] = [];
  const held = [...args.member.roles.cache.values()].filter((r) => targets.has(r.name.toLowerCase()));
  for (const r of held) {
    try {
      await args.member.roles.remove(r, `${args.actor.user.tag} removed Pod Representative`);
      removed.push(r.name);
    } catch {
      failed.push(r.name);
    }
  }
  if (removed.length > 0) {
    await postLog(
      args.member.guild,
      "audit",
      logEmbed("Pod Representative removed", 0xed4245)
        .setDescription(`<@${args.member.id}> (${removed.join(", ")})`)
        .addFields({ name: "By", value: `<@${args.actor.id}>` })
    );
  }
  return { removed, failed };
}

/** Reps per pod from the member cache (optionally one project). */
export function listPodReps(
  guild: Guild,
  projectKey?: string
): { memberId: string; project: string; module: number; pod: number }[] {
  const want = projectKey?.toLowerCase();
  const out: { memberId: string; project: string; module: number; pod: number }[] = [];
  for (const m of guild.members.cache.values()) {
    const names = [...m.roles.cache.values()].map((r) => r.name);
    for (const ref of leadershipFromRoleNames(names, org.projects).podRepOf) {
      if (!want || ref.project === want) out.push({ memberId: m.id, ...ref });
    }
  }
  return out;
}
