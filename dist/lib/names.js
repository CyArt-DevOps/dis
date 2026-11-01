/** Display label for a module: custom name if configured, else "Module N". */
export const moduleLabel = (p, mod) => p.moduleNames?.[String(mod)] ?? `Module ${mod}`;
/** Short label used in channel/category names: custom name if configured, else "MN". */
export const moduleShort = (p, mod) => p.moduleNames?.[String(mod)] ?? `M${mod}`;
export const roleNames = {
    intern: () => "Intern",
    admin: (name) => name,
    teamLead: () => "Team Lead",
    coLead: () => "Co-Lead",
    projectTeamLead: (p) => `${p.name} Team Lead`,
    projectCoLead: (p) => `${p.name} Co-Lead`,
    batch: (batch) => batch,
    project: (p) => p.name,
    module: (p, mod) => `${p.name} ${moduleLabel(p, mod)}`,
    pod: (p, mod, pod) => `${p.name} ${moduleLabel(p, mod)} Pod ${pod}`,
    /**
     * Phase 6 / 6b: one per pod, always numeric ("CyBreach M5 P2 Representative") even when the
     * module has a custom name. Capped at Discord's 100 chars, trimming the project part so the
     * " M<m> P<n> Representative" suffix (what makes pods distinct) survives.
     */
    podRep: (p, mod, pod) => {
        const suffix = ` M${mod} P${pod} Representative`;
        return `${p.name.slice(0, Math.max(0, ROLE_NAME_MAX - suffix.length))}${suffix}`;
    },
};
/** Discord's maximum role-name length. */
export const ROLE_NAME_MAX = 100;
/** Clamp any role name to Discord's limit. */
export const capRoleName = (name) => name.slice(0, ROLE_NAME_MAX);
/**
 * Pre-6b rep role name, which used the custom module label ("CyBreach Team Velocity P2
 * Representative"). Only for migrating / pruning old roles; never created or detected.
 */
export const legacyPodRep = (p, mod, pod) => capRoleName(`${p.name} ${moduleShort(p, mod)} P${pod} Representative`);
/** Every Pod Representative role a project should have, in module / pod order. */
export function podRepRoleNames(p) {
    const out = [];
    for (let m = 1; m <= p.modules; m++)
        for (let pd = 1; pd <= p.podsPerModule; pd++)
            out.push(roleNames.podRep(p, m, pd));
    return out;
}
export const channelNames = {
    modCategory: (mod) => `Module ${mod}`,
    podCategory: (pod) => `Pod ${pod}`,
    podChat: () => "chat",
    podResources: () => "resources",
    podVc: () => "Pod VC",
    leadership: () => "Leadership",
    teamLeadChat: () => "team-lead-chat",
    coleadChat: () => "colead-chat",
    leadershipVc: () => "Leadership VC",
    projectGeneral: () => "general",
    projectAnnouncements: () => "announcements",
};
/**
 * Category and voice-channel names exactly as bootstrap creates them. The
 * assigned-VC resolver (services/assignedVoice.ts) finds a member's channels by
 * these names + parent category, so bootstrap must use this too.
 */
export const placeNames = {
    projectCategory: (p) => p.name.toUpperCase(),
    moduleCategory: (p, mod) => `${p.name} ${moduleShort(p, mod)}`,
    projectGeneralVc: (p) => `${p.name} General VC`,
    leadershipVc: (p) => `${p.name} ${channelNames.leadershipVc()}`,
    moduleVc: (p, mod) => `${p.name} ${moduleShort(p, mod)} VC`,
    podVc: (p, mod, pod) => `${p.name} ${moduleShort(p, mod)} P${pod} VC`,
    /** Every category name bootstrap may create for a project (project + each module). */
    allCategories: (p) => [
        placeNames.projectCategory(p),
        ...Array.from({ length: p.modules }, (_, i) => placeNames.moduleCategory(p, i + 1)),
    ],
};
//# sourceMappingURL=names.js.map