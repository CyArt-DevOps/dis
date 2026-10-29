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
const { postLog } = await import("../src/lib/log.js");

type Role = { id: string; name: string };
const roleList: Role[] = [
  "CyBreach", "CyBreach Module 1", "CyBreach Module 1 Pod 2", "CyBreach M1 P2 Representative",
  "CyBreach M2 P1 Representative", "CyBreach Team Lead", "Student Representative",
  "CyBreach Module 2", "CyBreach Module 2 Pod 2",
].map((name, i) => ({ id: `r${i}`, name }));

function rolesCache(list: Role[]) {
  const m = new Map(list.map((r) => [r.id, r]));
  return Object.assign(m, {
    find: (f: (r: Role) => boolean) => [...m.values()].find(f),
    filter: (f: (r: Role) => boolean) => new Map([...m].filter(([, r]) => f(r))),
  });
}

function fakeMember(id: string, held: string[] = [], guildRoles: Role[] = roleList) {
  const mine = guildRoles.filter((r) => held.includes(r.name));
  const member = {
    id,
    user: { tag: id },
    guild: { roles: { cache: rolesCache(guildRoles) } },
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
    expect([...m.roles.cache.values()].map((r) => r.name).sort()).toEqual(
      ["CyBreach", "CyBreach M1 P2 Representative", "CyBreach Module 1", "CyBreach Module 1 Pod 2"]
    );
    expect(m.roles.add).toHaveBeenCalledTimes(4);
    expect(postLog).toHaveBeenCalledTimes(1);
    expect(postLog).toHaveBeenCalledWith(expect.anything(), "audit", expect.anything());
  });
  it("throws before adding anything when the rep role is missing (I1)", async () => {
    const m = fakeMember("u1");
    await expect(assignPodRep({ member: m as never, projectKey: "cybreach", moduleNum: 2, podNum: 2, actor }))
      .rejects.toThrow(/Rep role missing — run \/setup/);
    expect(m.roles.add).not.toHaveBeenCalled();
    expect(postLog).not.toHaveBeenCalled();
  });
  it("finds the rep role without case (M2)", async () => {
    const roles = [...roleList, { id: "rx", name: "cybreach m2 p2 representative" }];
    const m = fakeMember("u1", [], roles);
    const applied = await assignPodRep({ member: m as never, projectKey: "cybreach", moduleNum: 2, podNum: 2, actor });
    expect(applied[0]).toBe("cybreach m2 p2 representative");
    expect([...m.roles.cache.values()].map((r) => r.name)).toContain("cybreach m2 p2 representative");
  });
  it("refuses a pod the project does not have, and a project without pods", async () => {
    const m = fakeMember("u1");
    await expect(assignPodRep({ member: m as never, projectKey: "cybreach", moduleNum: 1, podNum: 9, actor })).rejects.toThrow(/no pod/i);
    await expect(assignPodRep({ member: m as never, projectKey: "ai", moduleNum: 1, podNum: 1, actor })).rejects.toThrow(/no pod/i);
  });
});

describe("removePodRep", () => {
  const held = (m: ReturnType<typeof fakeMember>) => [...m.roles.cache.values()].map((r) => r.name).sort();
  it("removes one pod's rep role, keeps membership roles, audits and returns what was removed", async () => {
    const m = fakeMember("u1", ["CyBreach", "CyBreach M1 P2 Representative", "CyBreach M2 P1 Representative"]);
    const res = await removePodRep({ member: m as never, actor, projectKey: "cybreach", moduleNum: 1, podNum: 2 });
    expect(res).toEqual({ removed: ["CyBreach M1 P2 Representative"], failed: [] });
    expect(held(m)).toEqual(["CyBreach", "CyBreach M2 P1 Representative"]);
    expect(postLog).toHaveBeenCalledTimes(1);
  });
  it("without any args removes every rep role, never Team Lead or a non-rep 'Representative' role", async () => {
    const m = fakeMember("u1", ["CyBreach Team Lead", "Student Representative", "CyBreach M1 P2 Representative", "CyBreach M2 P1 Representative"]);
    const res = await removePodRep({ member: m as never, actor });
    expect(res.removed.sort()).toEqual(["CyBreach M1 P2 Representative", "CyBreach M2 P1 Representative"]);
    expect(held(m)).toEqual(["CyBreach Team Lead", "Student Representative"]);
  });
  it("matches rep roles without case", async () => {
    const roles = [...roleList, { id: "rx", name: "cybreach m2 p2 representative" }];
    const m = fakeMember("u1", ["cybreach m2 p2 representative"], roles);
    const res = await removePodRep({ member: m as never, actor, projectKey: "cybreach", moduleNum: 2, podNum: 2 });
    expect(res.removed).toEqual(["cybreach m2 p2 representative"]);
  });
  it("project only → that project's rep roles; project + module → that module's (I2)", async () => {
    const m = fakeMember("u1", ["CyBreach M1 P2 Representative", "CyBreach M2 P1 Representative"]);
    const r1 = await removePodRep({ member: m as never, actor, projectKey: "cybreach", moduleNum: 2 });
    expect(r1.removed).toEqual(["CyBreach M2 P1 Representative"]);
    expect(held(m)).toEqual(["CyBreach M1 P2 Representative"]);
    const r2 = await removePodRep({ member: m as never, actor, projectKey: "cybreach" });
    expect(r2.removed).toEqual(["CyBreach M1 P2 Representative"]);
    expect(held(m)).toEqual([]);
  });
  it("rejects module / pod without a project, and pod without module (I3)", async () => {
    const m = fakeMember("u1", ["CyBreach M1 P2 Representative"]);
    await expect(removePodRep({ member: m as never, actor, moduleNum: 1 })).rejects.toThrow(/project/i);
    await expect(removePodRep({ member: m as never, actor, podNum: 2 })).rejects.toThrow(/project/i);
    await expect(removePodRep({ member: m as never, actor, projectKey: "cybreach", podNum: 2 })).rejects.toThrow(/module/i);
    await expect(removePodRep({ member: m as never, actor, projectKey: "nope" })).rejects.toThrow(/unknown project/i);
    expect(m.roles.remove).not.toHaveBeenCalled();
    expect(held(m)).toEqual(["CyBreach M1 P2 Representative"]);
  });
  it("reports failed removals and does not audit when nothing was removed (I4)", async () => {
    const m = fakeMember("u1", ["CyBreach M1 P2 Representative"]);
    m.roles.remove.mockRejectedValueOnce(new Error("Missing Permissions"));
    const res = await removePodRep({ member: m as never, actor });
    expect(res).toEqual({ removed: [], failed: ["CyBreach M1 P2 Representative"] });
    expect(postLog).not.toHaveBeenCalled();
    const none = await removePodRep({ member: fakeMember("u2") as never, actor });
    expect(none).toEqual({ removed: [], failed: [] });
    expect(postLog).not.toHaveBeenCalled();
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
