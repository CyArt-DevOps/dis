import { PermissionsBitField } from "discord.js";
import { org } from "../config/loader.js";
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
//# sourceMappingURL=rbac.js.map