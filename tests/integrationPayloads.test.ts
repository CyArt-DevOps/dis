import { describe, it, expect } from "vitest";
import { leadershipFromRoleNames, memberDto, orgDto, projectKeyOf } from "../src/services/integrationPayloads.js";

const projects = [
  { key: "dt", name: "DarkTrace", modules: 2, podsPerModule: 3, active: true, moduleNames: { "2": "Team Velocity" }, moduleChannels: false, moduleVoice: false },
  { key: "ct", name: "CTEM", modules: 0, podsPerModule: 0, active: false, moduleChannels: false, moduleVoice: false },
];

describe("leadershipFromRoleNames", () => {
  it("maps '<Project> Team Lead' and '<Project> Co-Lead' to project keys", () => {
    expect(leadershipFromRoleNames(["Intern", "DarkTrace Team Lead", "CTEM Co-Lead", "Team Lead"], projects)).toEqual({
      teamLeadOf: ["dt"],
      coLeadOf: ["ct"],
    });
  });
  it("returns empty lists for plain members", () => {
    expect(leadershipFromRoleNames(["Intern", "DarkTrace"], projects)).toEqual({ teamLeadOf: [], coLeadOf: [] });
  });
});

describe("memberDto", () => {
  it("falls back to displayName then tag for the name and serialises dates", () => {
    const d = memberDto(
      { id: "42", fullName: null, displayName: "Dee", tag: "dee#1", batch: "Batch 2026", project: "dt", module: 1, pod: 2,
        status: "active", verificationStatus: "verified", updatedAt: new Date("2026-10-26T10:00:00Z") },
      { teamLeadOf: [], coLeadOf: [] }
    );
    expect(d).toEqual({ id: "42", fullName: "Dee", tag: "dee#1", batch: "Batch 2026", project: "dt", module: 1, pod: 2,
      status: "active", verificationStatus: "verified", updatedAt: "2026-10-26T10:00:00.000Z",
      leadership: { teamLeadOf: [], coLeadOf: [] } });
  });
});

describe("projectKeyOf", () => {
  it("resolves the stored project name (or a key) to the project key", () => {
    expect(projectKeyOf("DarkTrace", projects)).toBe("dt");
    expect(projectKeyOf("dt", projects)).toBe("dt");
    expect(projectKeyOf("Gone Project", projects)).toBeNull();
    expect(projectKeyOf(null, projects)).toBeNull();
  });
});

describe("orgDto", () => {
  it("expands modules and pods with custom module names", () => {
    const o = orgDto(projects);
    expect(o.projects[0]).toEqual({
      key: "dt", name: "DarkTrace", active: true,
      modules: [ { num: 1, name: "Module 1", pods: [1, 2, 3] }, { num: 2, name: "Team Velocity", pods: [1, 2, 3] } ],
    });
    expect(o.projects[1]).toEqual({ key: "ct", name: "CTEM", active: false, modules: [] });
  });
});
