/**
 * Who `/project dissolve` removes from the server. Pure: the caller passes the
 * guild members (with their role names) and the ids the DB has on the project.
 */
/**
 * @param projectRoles role names of the dissolved project
 * @param otherProjectRoles role names of every other project (a holder is never removed)
 * @param dbMemberIds ids the bot's Member table lists in this project
 */
export function pickProjectMembers(members, projectRoles, otherProjectRoles, dbMemberIds) {
    const remove = [];
    const skipped = [];
    for (const m of members) {
        const inProject = dbMemberIds.has(m.id) || m.roleNames.some((r) => projectRoles.has(r));
        if (!inProject)
            continue;
        const skip = (reason) => skipped.push({ id: m.id, tag: m.tag, reason });
        if (m.bot)
            skip("bot");
        else if (m.staff)
            skip("staff");
        // A role name another project also uses counts too: when in doubt, nobody is kicked.
        else if (m.roleNames.some((r) => otherProjectRoles.has(r)))
            skip("other project");
        else
            remove.push(m);
    }
    return { remove, skipped };
}
//# sourceMappingURL=projectMembers.js.map