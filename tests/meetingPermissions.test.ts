import { describe, it, expect } from "vitest";
import type { GuildMember } from "discord.js";
import { canSchedule } from "../src/commands/meeting.js";
import { activeProjects } from "../src/config/loader.js";
import { roleNames } from "../src/lib/names.js";

const [projectA, projectB] = activeProjects();

/** Minimal stand-in for a GuildMember: canSchedule only reads roles + perms. */
function member(roles: string[], { admin = false } = {}): GuildMember {
  return {
    id: "u1",
    guild: { ownerId: "owner" },
    roles: { cache: { some: (fn: (r: { name: string }) => boolean) => roles.map((name) => ({ name })).some(fn) } },
    permissions: { has: () => admin },
  } as unknown as GuildMember;
}

const teamLeadOfA = member(["Team Lead", roleNames.projectTeamLead(projectA!), roleNames.project(projectA!)]);
const coLeadOfA = member(["Co-Lead", roleNames.projectCoLead(projectA!), roleNames.project(projectA!)]);
const manager = member(["Manager"]);
const intern = member(["Intern"]);

describe("canSchedule — staff", () => {
  it("lets Manager schedule anything", () => {
    for (const a of ["org", "batch", "project", "module", "pod", "people"] as const) {
      expect(canSchedule(manager, a, projectA!.key)).toBe(true);
    }
  });
});

describe("canSchedule — project Team Lead", () => {
  it("allows project, module and pod meetings for their own project", () => {
    for (const a of ["project", "module", "pod"] as const) {
      expect(canSchedule(teamLeadOfA, a, projectA!.key)).toBe(true);
    }
  });

  it("refuses another project", () => {
    if (!projectB) return; // single-project config
    expect(canSchedule(teamLeadOfA, "project", projectB.key)).toBe(false);
  });

  it("refuses org-wide and batch meetings", () => {
    expect(canSchedule(teamLeadOfA, "org", projectA!.key)).toBe(false);
    expect(canSchedule(teamLeadOfA, "batch", projectA!.key)).toBe(false);
  });

  it("refuses Specific People meetings (they grant office VC access)", () => {
    expect(canSchedule(teamLeadOfA, "people", projectA!.key)).toBe(false);
  });

  it("refuses when no project is given", () => {
    expect(canSchedule(teamLeadOfA, "project", undefined)).toBe(false);
  });

  it("refuses a bare 'Team Lead' role with no per-project role", () => {
    expect(canSchedule(member(["Team Lead"]), "project", projectA!.key)).toBe(false);
  });
});

describe("canSchedule — Co-Lead has no scheduling access", () => {
  it("refuses every audience, including their own pod", () => {
    for (const a of ["org", "batch", "project", "module", "pod", "people"] as const) {
      expect(canSchedule(coLeadOfA, a, projectA!.key)).toBe(false);
    }
  });
});

describe("canSchedule — interns", () => {
  it("refuses everything", () => {
    expect(canSchedule(intern, "project", projectA!.key)).toBe(false);
    expect(canSchedule(intern, "pod", projectA!.key)).toBe(false);
  });
});
