import { describe, it, expect, vi } from "vitest";

// RC-DIS-03 (helper): "<Project> Team Lead" of that project — not the org-wide "Team Lead" role, not another project's.
const projects = [{ key: "cybreach", name: "CyBreach", modules: 2, podsPerModule: 2, active: true }, { key: "ai", name: "AI SIEM", modules: 1, podsPerModule: 1, active: true }];
vi.mock("../src/config/loader.js", () => ({ org: { projects, roles: { admin: ["Founder", "Manager", "HR"] } }, findProject: (k: string) => projects.find((p) => p.key === k.toLowerCase()) }));
const { isProjectTeamLead } = await import("../src/lib/rbac.js");

const member = (...names: string[]) => ({ roles: { cache: { some: (f: (r: { name: string }) => boolean) => names.map((name) => ({ name })).some(f) } } }) as never;

describe("isProjectTeamLead", () => {
  it("true only for that project's Team Lead role", () => {
    expect(isProjectTeamLead(member("CyBreach Team Lead"), "cybreach")).toBe(true);
    expect(isProjectTeamLead(member("CyBreach Team Lead"), "CYBREACH")).toBe(true);
    expect(isProjectTeamLead(member("AI SIEM Team Lead", "Team Lead"), "cybreach")).toBe(false);
    expect(isProjectTeamLead(member("CyBreach Co-Lead"), "cybreach")).toBe(false);
    expect(isProjectTeamLead(member("CyBreach Team Lead"), "nope")).toBe(false);
  });
  it("matches the role name without case", () => {
    expect(isProjectTeamLead(member("cybreach team lead"), "cybreach")).toBe(true);
    expect(isProjectTeamLead(member("CYBREACH TEAM LEAD"), "cybreach")).toBe(true);
    expect(isProjectTeamLead(member("cybreach co-lead"), "cybreach")).toBe(false);
  });
});
