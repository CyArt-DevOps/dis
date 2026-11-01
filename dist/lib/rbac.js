import { PermissionsBitField } from "discord.js";
import { findProject, org } from "../config/loader.js";
import { roleNames } from "./names.js";
export function hasAdminRole(member, ...roles) {
    const allowed = roles.length > 0 ? roles : org.roles.admin;
    return member.roles.cache.some((r) => allowed.includes(r.name));
}
export function isFounder(member) {
    if (member.guild.ownerId === member.id)
        return true;
    return hasAdminRole(member, "Founder");
}
export function isStaff(member) {
    return (isFounder(member) ||
        hasAdminRole(member, "Manager", "HR") ||
        member.permissions.has(PermissionsBitField.Flags.Administrator));
}
export function canManageLeadership(member) {
    return isStaff(member);
}
/** Holds "<Project> Team Lead" for this project (sub-project C: Team Leads manage their project's Pod Reps). */
export function isProjectTeamLead(member, projectKey) {
    const p = findProject(projectKey);
    if (!p)
        return false;
    // Without case, like the rep roles (findRoleCi): a hand-renamed "cybreach team lead" still counts.
    const name = roleNames.projectTeamLead(p).toLowerCase();
    return member.roles.cache.some((r) => r.name.toLowerCase() === name);
}
//# sourceMappingURL=rbac.js.map