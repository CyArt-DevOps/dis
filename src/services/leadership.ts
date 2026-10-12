import { Guild, GuildMember, Role } from "discord.js";
import { findProject } from "../config/loader.js";
import { roleNames } from "../lib/names.js";
import { logEmbed, postLog } from "../lib/log.js";

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
