import type { ProjectDef } from "../config/loader.js";

/** Display label for a module: custom name if configured, else "Module N". */
export const moduleLabel = (p: ProjectDef, mod: number): string =>
  p.moduleNames?.[String(mod)] ?? `Module ${mod}`;

/** Short label used in channel/category names: custom name if configured, else "MN". */
export const moduleShort = (p: ProjectDef, mod: number): string =>
  p.moduleNames?.[String(mod)] ?? `M${mod}`;

export const roleNames = {
  intern: () => "Intern",
  admin: (name: string) => name,
  teamLead: () => "Team Lead",
  coLead: () => "Co-Lead",
  projectTeamLead: (p: ProjectDef) => `${p.name} Team Lead`,
  projectCoLead: (p: ProjectDef) => `${p.name} Co-Lead`,
  batch: (batch: string) => batch,
  project: (p: ProjectDef) => p.name,
  module: (p: ProjectDef, mod: number) => `${p.name} ${moduleLabel(p, mod)}`,
  pod: (p: ProjectDef, mod: number, pod: number) =>
    `${p.name} ${moduleLabel(p, mod)} Pod ${pod}`,
};

export const channelNames = {
  modCategory: (mod: number) => `Module ${mod}`,
  podCategory: (pod: number) => `Pod ${pod}`,
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
