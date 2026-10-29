import { describe, it, expect, vi, beforeEach } from "vitest";

// Bootstrap's Pod Representative roles (Phase 6): created in a second pass after every
// membership role, never past Discord's 250-role limit, legacy custom-label names renamed,
// and pruned (with an audit of holders) when the pod is gone.
const posted: { title: string; desc?: string }[] = [];
vi.mock("../src/lib/log.js", () => ({
  postLog: vi.fn(async (_g: unknown, _c: unknown, e: { title: string; desc?: string }) => { posted.push(e); }),
  logEmbed: (title: string) => ({
    title,
    desc: undefined as string | undefined,
    setDescription(d: string) { this.desc = d; return this; },
    addFields() { return this; },
  }),
}));
vi.mock("../src/core/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../src/core/state.js", () => ({ readState: vi.fn(() => ({})), updateState: vi.fn() }));
vi.mock("../src/services/onboarding.js", () => ({ beginButton: vi.fn(), IDS: {} }));
vi.mock("../src/services/leave.js", () => ({ LEAVE_IDS: {}, leavePanelButton: vi.fn(), leavePanelEmbed: vi.fn() }));
vi.mock("../src/services/tickets.js", () => ({
  TICKET_IDS: {}, panelButton: vi.fn(), panelEmbed: vi.fn(), projectPanelButton: vi.fn(),
  projectPanelEmbed: vi.fn(), staffTalkPanelButtons: vi.fn(), staffTalkPanelEmbed: vi.fn(),
}));

type P = { key: string; name: string; modules: number; podsPerModule: number; active: boolean; moduleNames?: Record<string, string> };
const projects: P[] = [];
vi.mock("../src/config/loader.js", () => ({
  activeProjects: () => projects.filter((p) => p.active),
  org: {
    roles: { admin: ["Founder", "Manager", "HR"], leadership: ["Team Lead", "Co-Lead"] },
    batches: ["B1"],
    projects,
    categories: { logs: { name: "LOGS" } },
  },
}));

const { ensureRoles, pruneProject } = await import("../src/services/bootstrap.js");

type FakeRole = {
  id: string; name: string; permissions: { bitfield: bigint };
  members: Map<string, { id: string }>;
  setPermissions: ReturnType<typeof vi.fn>; setName: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>;
};

function fakeGuild(existing: string[], opts: { failRep?: (n: number) => boolean } = {}) {
  let seq = 0;
  const cache = new Map<string, FakeRole>();
  const mk = (name: string): FakeRole => {
    const id = `r${seq++}`;
    const role: FakeRole = {
      id, name, permissions: { bitfield: 0n }, members: new Map(),
      setPermissions: vi.fn(async () => role),
      setName: vi.fn(async (n: string) => { role.name = n; return role; }),
      delete: vi.fn(async () => { cache.delete(id); }),
    };
    cache.set(id, role);
    return role;
  };
  for (const n of existing) mk(n);
  let repCreates = 0;
  const rolesCache = Object.assign(cache, {
    find: (f: (r: FakeRole) => boolean) => [...cache.values()].find(f),
  });
  const create = vi.fn(async ({ name }: { name: string }) => {
    if (name.endsWith(" Representative") && opts.failRep?.(repCreates++)) {
      throw Object.assign(new Error("Maximum number of guild roles reached (250)"), { code: 30005 });
    }
    return mk(name);
  });
  const channels = Object.assign(new Map(), { find: () => undefined });
  return { guild: { name: "G", roles: { cache: rolesCache, create }, channels: { cache: channels } }, create, cache, mk };
}

const names = (g: ReturnType<typeof fakeGuild>) => [...g.cache.values()].map((r) => r.name);
const fillers = (n: number) => ["@everyone", ...Array.from({ length: n - 1 }, (_, i) => `filler ${i}`)];
const MEMBERSHIP = [
  "Founder", "Manager", "HR", "Team Lead", "Co-Lead", "Intern", "B1",
  "CyBreach", "CyBreach Team Lead", "CyBreach Co-Lead",
  "CyBreach Module 1", "CyBreach Module 1 Pod 1", "CyBreach Module 1 Pod 2",
  "CyBreach Module 2", "CyBreach Module 2 Pod 1", "CyBreach Module 2 Pod 2",
];
const REPS = ["CyBreach M1 P1 Representative", "CyBreach M1 P2 Representative", "CyBreach M2 P1 Representative", "CyBreach M2 P2 Representative"];

beforeEach(() => {
  vi.clearAllMocks();
  posted.length = 0;
  projects.splice(0, projects.length, { key: "cybreach", name: "CyBreach", modules: 2, podsPerModule: 2, active: true });
});

describe("ensureRoles — Pod Representative pass", () => {
  it("creates rep roles after every membership role", async () => {
    const g = fakeGuild(["@everyone"]);
    const report = await ensureRoles(g.guild as never);
    const created = g.create.mock.calls.map(([o]) => (o as { name: string }).name);
    expect(created).toEqual([...MEMBERSHIP, ...REPS]);
    expect(report.repRoles).toMatchObject({ wanted: 4, created: 4, notCreated: 0, shortfall: 0 });
    expect(report.roles.get("podrep:cybreach:2:2")?.name).toBe("CyBreach M2 P2 Representative");
  });

  it("near the 250-role limit: creates all membership roles, skips rep roles and reports the shortfall", async () => {
    // 231 existing + 16 membership = 247; 4 reps would make 251.
    const g = fakeGuild(fillers(231));
    const report = await ensureRoles(g.guild as never);
    expect(names(g)).toEqual(expect.arrayContaining(MEMBERSHIP));
    expect(names(g).filter((n) => n.endsWith("Representative"))).toEqual([]);
    expect(report.repRoles).toMatchObject({ wanted: 4, created: 0, notCreated: 4, shortfall: 1 });
    expect(report.repRoles.error).toMatch(/250/);
  });

  it("exactly at the limit still creates the rep roles", async () => {
    const g = fakeGuild(fillers(230));
    const report = await ensureRoles(g.guild as never);
    expect(report.repRoles).toMatchObject({ created: 4, notCreated: 0 });
    expect(g.cache.size).toBe(250);
  });

  it("a Discord error (30005) stops rep-role creation without throwing", async () => {
    const g = fakeGuild(["@everyone"], { failRep: (n) => n >= 1 });
    const report = await ensureRoles(g.guild as never);
    const repCalls = g.create.mock.calls.filter(([o]) => (o as { name: string }).name.endsWith("Representative"));
    expect(repCalls).toHaveLength(2); // one ok, one failed, then stop
    expect(names(g)).toEqual(expect.arrayContaining(MEMBERSHIP));
    expect(report.repRoles).toMatchObject({ created: 1, notCreated: 3 });
    expect(report.repRoles.error).toMatch(/30005|250/);
  });

  it("renames a legacy custom-label rep role so holders keep it", async () => {
    projects[0]!.moduleNames = { "2": "Velocity" };
    const g = fakeGuild(["@everyone", "CyBreach Velocity P1 Representative"]);
    const legacy = [...g.cache.values()].find((r) => r.name === "CyBreach Velocity P1 Representative")!;
    const report = await ensureRoles(g.guild as never);
    expect(legacy.setName).toHaveBeenCalledWith("CyBreach M2 P1 Representative", expect.any(String));
    expect(report.roles.get("podrep:cybreach:2:1")).toBe(legacy);
    expect(names(g).filter((n) => n === "CyBreach M2 P1 Representative")).toHaveLength(1);
    expect(report.repRoles).toMatchObject({ renamed: 1, created: 3 });
  });

  it("reuses a rep role whose name differs only in case", async () => {
    const g = fakeGuild(["@everyone", "cybreach m1 p1 representative"]);
    const report = await ensureRoles(g.guild as never);
    expect(report.repRoles).toMatchObject({ created: 3 });
    expect(report.roles.get("podrep:cybreach:1:1")?.name).toBe("cybreach m1 p1 representative");
  });

  it("a project with no modules gets no rep roles", async () => {
    projects.splice(0, 1, { key: "ai", name: "AI SIEM", modules: 0, podsPerModule: 0, active: true });
    const g = fakeGuild(["@everyone"]);
    const report = await ensureRoles(g.guild as never);
    expect(names(g).filter((n) => n.endsWith("Representative"))).toEqual([]);
    expect(report.repRoles).toMatchObject({ wanted: 0, created: 0, notCreated: 0 });
  });
});

describe("pruneProject — Pod Representative roles", () => {
  const p: P = { key: "cybreach", name: "CyBreach", modules: 1, podsPerModule: 1, active: true, moduleNames: { "1": "Velocity" } };
  it("prunes rep roles of removed pods (numeric, any case) and legacy names; leaves others alone", async () => {
    const g = fakeGuild([
      "CyBreach M1 P1 Representative",
      "CyBreach M2 P1 Representative",
      "CyBreach M1 P3 Representative",
      "cybreach m3 p1 representative",
      "CyBreach Velocity P1 Representative",
      "Other M5 P5 Representative",
      "CyBreach 2.0 M9 P9 Representative",
      "CyBreach Club Representative",
    ]);
    await pruneProject(g.guild as never, p as never);
    expect(names(g).sort()).toEqual([
      "CyBreach 2.0 M9 P9 Representative",
      "CyBreach Club Representative",
      "CyBreach M1 P1 Representative",
      "Other M5 P5 Representative",
    ]);
  });

  it("posts an audit listing holders before pruning a held rep role", async () => {
    const g = fakeGuild(["CyBreach M2 P1 Representative", "CyBreach M3 P1 Representative"]);
    const held = [...g.cache.values()][0]!;
    held.members.set("u1", { id: "u1" });
    held.members.set("u2", { id: "u2" });
    await pruneProject(g.guild as never, p as never);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.desc).toContain("CyBreach M2 P1 Representative");
    expect(posted[0]!.desc).toContain("<@u1>");
    expect(posted[0]!.desc).toContain("<@u2>");
    expect(held.delete).toHaveBeenCalled();
  });
});

describe("/setup reply", () => {
  it("reports rep roles that were not created and the shortfall", async () => {
    const { setupSummary } = await import("../src/commands/setup.js");
    const base = { rolesCreated: 16, projectsBuilt: 1 };
    expect(setupSummary({ ...base, repRoles: { wanted: 4, created: 4, renamed: 0, notCreated: 0, shortfall: 0 } }))
      .toBe("Done. New roles: 16. Active projects built: 1.");
    const msg = setupSummary({
      ...base,
      repRoles: { wanted: 4, created: 0, renamed: 0, notCreated: 4, shortfall: 1, error: "would exceed Discord's 250-role limit by 1" },
    });
    expect(msg).toMatch(/4 of 4 Pod Representative role\(s\) were not created/);
    expect(msg).toMatch(/Free up 1 role/);
  });
});
