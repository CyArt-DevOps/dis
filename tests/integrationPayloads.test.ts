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
      podRepOf: [],
    });
  });
  it("returns empty lists for plain members", () => {
    expect(leadershipFromRoleNames(["Intern", "DarkTrace"], projects)).toEqual({ teamLeadOf: [], coLeadOf: [], podRepOf: [] });
  });
});

describe("leadershipFromRoleNames — Pod Representatives (Phase 6)", () => {
  const pods = (names: string[]) => leadershipFromRoleNames(names, projects).podRepOf;
  it("PR-BOT-01: '<Project> M<m> P<n> Representative' → { project, module, pod }", () => {
    expect(pods(["Intern", "DarkTrace M1 P2 Representative"])).toEqual([{ project: "dt", module: 1, pod: 2 }]);
  });
  it("PR-BOT-02: several rep roles come back sorted; custom-named modules still use the number", () => {
    expect(pods(["DarkTrace M2 P1 Representative", "DarkTrace M1 P3 Representative"])).toEqual([
      { project: "dt", module: 1, pod: 3 }, { project: "dt", module: 2, pod: 1 },
    ]);
  });
  it("PR-BOT-02b: the legacy custom-label form is not detected", () => {
    expect(pods(["DarkTrace Team Velocity P1 Representative"])).toEqual([]);
  });
  it("PR-BOT-03: a module or pod beyond the configured counts is ignored", () => {
    expect(pods(["DarkTrace M9 P9 Representative", "DarkTrace M1 P7 Representative"])).toEqual([]);
  });
  it("PR-BOT-04: a project with no modules has no reps", () => {
    expect(pods(["CTEM M1 P1 Representative"])).toEqual([]);
  });
  it("PR-BOT-05: role names are compared without case", () => {
    expect(pods(["darktrace m1 p2 representative"])).toEqual([{ project: "dt", module: 1, pod: 2 }]);
  });
  it("PR-BOT-06: Team Lead and rep together", () => {
    expect(leadershipFromRoleNames(["DarkTrace Team Lead", "DarkTrace M1 P1 Representative"], projects)).toEqual({
      teamLeadOf: ["dt"], coLeadOf: [], podRepOf: [{ project: "dt", module: 1, pod: 1 }],
    });
  });
  it("PR-BOT-07: a Co-Lead is not a rep", () => {
    expect(pods(["DarkTrace Co-Lead", "Co-Lead"])).toEqual([]);
  });
});

describe("memberDto", () => {
  it("falls back to displayName then tag for the name and serialises dates", () => {
    const d = memberDto(
      { id: "42", fullName: null, displayName: "Dee", tag: "dee#1", batch: "Batch 2026", project: "dt", module: 1, pod: 2,
        status: "active", verificationStatus: "verified", updatedAt: new Date("2026-10-26T10:00:00Z") },
      { teamLeadOf: [], coLeadOf: [], podRepOf: [] }
    );
    expect(d).toEqual({ id: "42", fullName: "Dee", tag: "dee#1", batch: "Batch 2026", project: "dt", module: 1, pod: 2,
      status: "active", verificationStatus: "verified", updatedAt: "2026-10-26T10:00:00.000Z",
      leadership: { teamLeadOf: [], coLeadOf: [], podRepOf: [] } });
  });
});

describe("projectKeyOf", () => {
  it("resolves the stored project name (or a key) to the project key", () => {
    expect(projectKeyOf("DarkTrace", projects)).toBe("dt");
    expect(projectKeyOf("dt", projects)).toBe("dt");
    expect(projectKeyOf("Gone Project", projects)).toBeNull();
    expect(projectKeyOf(null, projects)).toBeNull();
  });
  it("ignores case and surrounding whitespace", () => {
    expect(projectKeyOf("  darktrace ", projects)).toBe("dt");
    expect(projectKeyOf("DT", projects)).toBe("dt");
    expect(projectKeyOf("   ", projects)).toBeNull();
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
