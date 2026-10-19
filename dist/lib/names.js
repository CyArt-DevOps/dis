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
};
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
//# sourceMappingURL=names.js.map