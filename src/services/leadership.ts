import { Guild, GuildMember, Role } from "discord.js";
import { findProject, org } from "../config/loader.js";
import { roleNames } from "../lib/names.js";
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

/** Adds the rep role plus the project / module / pod membership roles, so the rep is in the pod. */
export async function assignPodRep(args: PodRepArgs): Promise<string[]> {
  const p = findProject(args.projectKey);
  if (!p || args.moduleNum < 1 || args.moduleNum > p.modules || args.podNum < 1 || args.podNum > p.podsPerModule)
    throw new Error(`${p ? p.name : args.projectKey} has no pod M${args.moduleNum} P${args.podNum}`);
  const roles = [
    roleNames.podRep(p, args.moduleNum, args.podNum),
    roleNames.project(p),
    roleNames.module(p, args.moduleNum),
    roleNames.pod(p, args.moduleNum, args.podNum),
  ];
  const applied: string[] = [];
  for (const name of roles) {
    const r = findRole(args.member.guild, name);
    if (!r) continue;
    if (!args.member.roles.cache.has(r.id)) {
      await args.member.roles.add(r, `${args.actor.user.tag} assigned Pod Representative`);
    }
    applied.push(name);
  }
  await postLog(
    args.member.guild,
    "audit",
    logEmbed("Pod Representative assigned", 0x1abc9c)
      .setDescription(`<@${args.member.id}> → ${p.name} M${args.moduleNum} P${args.podNum}`)
      .addFields({ name: "By", value: `<@${args.actor.id}>` })
  );
  return applied;
}

/** Removes one pod's rep role, or every rep role when no pod is given. Membership roles stay. */
export async function removePodRep(args: {
  member: GuildMember;
  actor: GuildMember;
  projectKey?: string;
  moduleNum?: number;
  podNum?: number;
}): Promise<void> {
  const p = args.projectKey ? findProject(args.projectKey) : undefined;
  const one = p && args.moduleNum && args.podNum ? roleNames.podRep(p, args.moduleNum, args.podNum) : null;
  const toRemove = args.member.roles.cache.filter((r) =>
    one ? r.name === one : r.name.endsWith(" Representative")
  );
  for (const r of toRemove.values()) {
    await args.member.roles.remove(r, `${args.actor.user.tag} removed Pod Representative`).catch(() => {});
  }
  await postLog(
    args.member.guild,
    "audit",
    logEmbed("Pod Representative removed", 0xed4245)
      .setDescription(`<@${args.member.id}>${one ? ` (${one})` : ""}`)
      .addFields({ name: "By", value: `<@${args.actor.id}>` })
  );
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
