import { describe, it, expect, vi, beforeEach } from "vitest";

// /rep assign | remove | list (Phase 6): the service is tested against a fake guild — role
// objects are { id, name }, the member records adds / removes.
vi.mock("../src/lib/log.js", () => ({
  postLog: vi.fn(async () => {}),
  logEmbed: () => ({ setDescription() { return this; }, addFields() { return this; } }),
}));
const projects = [
  { key: "cybreach", name: "CyBreach", modules: 2, podsPerModule: 2, active: true },
  { key: "ai", name: "AI SIEM", modules: 0, podsPerModule: 0, active: true },
];
vi.mock("../src/config/loader.js", () => ({
  findProject: (k: string) => projects.find((p) => p.key === k.toLowerCase()),
  org: { projects },
}));

const { assignPodRep, removePodRep, listPodReps } = await import("../src/services/leadership.js");

type Role = { id: string; name: string };
const roleList: Role[] = [
  "CyBreach", "CyBreach Module 1", "CyBreach Module 1 Pod 2", "CyBreach M1 P2 Representative",
  "CyBreach M2 P1 Representative", "CyBreach Team Lead",
].map((name, i) => ({ id: `r${i}`, name }));

function rolesCache(list: Role[]) {
  const m = new Map(list.map((r) => [r.id, r]));
  return Object.assign(m, {
    find: (f: (r: Role) => boolean) => [...m.values()].find(f),
    filter: (f: (r: Role) => boolean) => new Map([...m].filter(([, r]) => f(r))),
  });
}

function fakeMember(id: string, held: string[] = []) {
  const mine = roleList.filter((r) => held.includes(r.name));
  const member = {
    id,
    user: { tag: id },
    guild: { roles: { cache: rolesCache(roleList) } },
    roles: {
      cache: rolesCache(mine),
      add: vi.fn(async (r: Role) => { member.roles.cache.set(r.id, r); }),
      remove: vi.fn(async (r: Role) => { member.roles.cache.delete(r.id); }),
    },
  };
  return member;
}
const actor = fakeMember("hr") as never;

beforeEach(() => vi.clearAllMocks());

describe("assignPodRep", () => {
  it("adds the rep role plus project, module and pod membership", async () => {
    const m = fakeMember("u1");
    const applied = await assignPodRep({ member: m as never, projectKey: "cybreach", moduleNum: 1, podNum: 2, actor });
    expect(applied).toEqual(["CyBreach M1 P2 Representative", "CyBreach", "CyBreach Module 1", "CyBreach Module 1 Pod 2"]);
    expect([...m.roles.cache.values()].map((r) => r.name)).toContain("CyBreach M1 P2 Representative");
  });
  it("refuses a pod the project does not have, and a project without pods", async () => {
    const m = fakeMember("u1");
    await expect(assignPodRep({ member: m as never, projectKey: "cybreach", moduleNum: 1, podNum: 9, actor })).rejects.toThrow(/no pod/i);
    await expect(assignPodRep({ member: m as never, projectKey: "ai", moduleNum: 1, podNum: 1, actor })).rejects.toThrow(/no pod/i);
  });
});

describe("removePodRep", () => {
  it("removes one pod's rep role and keeps membership roles", async () => {
    const m = fakeMember("u1", ["CyBreach", "CyBreach M1 P2 Representative", "CyBreach M2 P1 Representative"]);
    await removePodRep({ member: m as never, actor, projectKey: "cybreach", moduleNum: 1, podNum: 2 });
    expect([...m.roles.cache.values()].map((r) => r.name).sort()).toEqual(["CyBreach", "CyBreach M2 P1 Representative"]);
  });
  it("without a pod removes every rep role, never the Team Lead role", async () => {
    const m = fakeMember("u1", ["CyBreach Team Lead", "CyBreach M1 P2 Representative", "CyBreach M2 P1 Representative"]);
    await removePodRep({ member: m as never, actor });
    expect([...m.roles.cache.values()].map((r) => r.name)).toEqual(["CyBreach Team Lead"]);
  });
});

describe("listPodReps", () => {
  it("lists reps per pod, optionally for one project", () => {
    const rep = { id: "u1", roles: { cache: rolesCache(roleList.filter((r) => r.name === "CyBreach M1 P2 Representative")) } };
    const plain = { id: "u2", roles: { cache: rolesCache([]) } };
    const guild = { members: { cache: new Map([["u1", rep], ["u2", plain]]) } } as never;
    expect(listPodReps(guild)).toEqual([{ memberId: "u1", project: "cybreach", module: 1, pod: 2 }]);
    expect(listPodReps(guild, "ai")).toEqual([]);
  });
});
