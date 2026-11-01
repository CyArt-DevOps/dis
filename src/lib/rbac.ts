import { GuildMember, PermissionsBitField } from "discord.js";
import { findProject, org } from "../config/loader.js";
import { roleNames } from "./names.js";

export type AdminRole = "Founder" | "Manager" | "HR";

export function hasAdminRole(member: GuildMember, ...roles: AdminRole[]): boolean {
  const allowed = roles.length > 0 ? roles : (org.roles.admin as AdminRole[]);
  return member.roles.cache.some((r) => allowed.includes(r.name as AdminRole));
}

export function isFounder(member: GuildMember): boolean {
  if (member.guild.ownerId === member.id) return true;
  return hasAdminRole(member, "Founder");
}

export function isStaff(member: GuildMember): boolean {
  return (
    isFounder(member) ||
    hasAdminRole(member, "Manager", "HR") ||
    member.permissions.has(PermissionsBitField.Flags.Administrator)
  );
}

export function canManageLeadership(member: GuildMember): boolean {
  return isStaff(member);
}

/** Holds "<Project> Team Lead" for this project (sub-project C: Team Leads manage their project's Pod Reps). */
export function isProjectTeamLead(member: GuildMember, projectKey: string): boolean {
  const p = findProject(projectKey);
  if (!p) return false;
  const name = roleNames.projectTeamLead(p);
  return member.roles.cache.some((r) => r.name === name);
}
