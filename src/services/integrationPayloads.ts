import type { ProjectDef } from "../config/loader.js";
import { moduleLabel, roleNames } from "../lib/names.js";

/** Wire shapes for the EMS integration. EMS's disMapping.js consumes these. */
export interface Leadership {
  teamLeadOf: string[];
  coLeadOf: string[];
}

export interface MemberDto {
  id: string;
  fullName: string;
  tag: string | null;
  batch: string | null;
  project: string | null;
  module: number | null;
  pod: number | null;
  status: string;
  verificationStatus: string;
  updatedAt: string;
  leadership: Leadership;
}

export interface OrgDto {
  projects: { key: string; name: string; active: boolean; modules: { num: number; name: string; pods: number[] }[] }[];
}

type ProjectLike = Pick<ProjectDef, "key" | "name" | "modules" | "podsPerModule" | "active" | "moduleNames">;

/** Leads live only as Discord roles ("<Project> Team Lead"), so derive them from role names. */
export function leadershipFromRoleNames(names: string[], projects: ProjectLike[]): Leadership {
  const has = new Set(names);
  const out: Leadership = { teamLeadOf: [], coLeadOf: [] };
  for (const p of projects) {
    if (has.has(roleNames.projectTeamLead(p as ProjectDef))) out.teamLeadOf.push(p.key);
    if (has.has(roleNames.projectCoLead(p as ProjectDef))) out.coLeadOf.push(p.key);
  }
  return out;
}

/**
 * Member.project stores the project's display name (onboarding writes p.name),
 * but EMS keys projects by `key`. Accept either, return the key (null if the
 * project no longer exists in org.json).
 */
export function projectKeyOf(value: string | null, projects: ProjectLike[]): string | null {
  if (!value) return null;
  return projects.find((p) => p.key === value || p.name === value)?.key ?? null;
}

export function memberDto(
  m: {
    id: string;
    fullName: string | null;
    displayName: string | null;
    tag: string | null;
    batch: string | null;
    project: string | null;
    module: number | null;
    pod: number | null;
    status: string;
    verificationStatus: string;
    updatedAt: Date;
  },
  leadership: Leadership
): MemberDto {
  return {
    id: m.id,
    fullName: m.fullName ?? m.displayName ?? m.tag ?? m.id,
    tag: m.tag,
    batch: m.batch,
    project: m.project,
    module: m.module,
    pod: m.pod,
    status: m.status,
    verificationStatus: m.verificationStatus,
    updatedAt: m.updatedAt.toISOString(),
    leadership,
  };
}

export function orgDto(projects: ProjectLike[]): OrgDto {
  return {
    projects: projects.map((p) => ({
      key: p.key,
      name: p.name,
      active: p.active,
      modules: Array.from({ length: p.modules }, (_, i) => ({
        num: i + 1,
        name: moduleLabel(p as ProjectDef, i + 1),
        pods: Array.from({ length: p.podsPerModule }, (_, j) => j + 1),
      })),
    })),
  };
}
