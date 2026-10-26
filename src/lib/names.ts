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

/**
 * Category and voice-channel names exactly as bootstrap creates them. The
 * assigned-VC resolver (services/assignedVoice.ts) finds a member's channels by
 * these names + parent category, so bootstrap must use this too.
 */
export const placeNames = {
  projectCategory: (p: ProjectDef) => p.name.toUpperCase(),
  moduleCategory: (p: ProjectDef, mod: number) => `${p.name} ${moduleShort(p, mod)}`,
  projectGeneralVc: (p: ProjectDef) => `${p.name} General VC`,
  leadershipVc: (p: ProjectDef) => `${p.name} ${channelNames.leadershipVc()}`,
  moduleVc: (p: ProjectDef, mod: number) => `${p.name} ${moduleShort(p, mod)} VC`,
  podVc: (p: ProjectDef, mod: number, pod: number) => `${p.name} ${moduleShort(p, mod)} P${pod} VC`,
  /** Every category name bootstrap may create for a project (project + each module). */
  allCategories: (p: ProjectDef): string[] => [
    placeNames.projectCategory(p),
    ...Array.from({ length: p.modules }, (_, i) => placeNames.moduleCategory(p, i + 1)),
  ],
};
