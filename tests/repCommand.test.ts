import { describe, it, expect, vi, beforeEach } from "vitest";

// /rep command wiring (Phase 6): permission gate, deferred replies, remove result text,
// and a /rep list that stays under Discord's 2000-char limit and shows project names.
const canManage = vi.fn(() => true);
vi.mock("../src/lib/rbac.js", () => ({ canManageLeadership: () => canManage() }));
const projects = [{ key: "cybreach", name: "CyBreach", modules: 2, podsPerModule: 2, active: true }];
vi.mock("../src/config/loader.js", () => ({ activeProjects: () => projects, org: { projects } }));
const svc = {
  assignPodRep: vi.fn(async () => ["CyBreach M1 P2 Representative", "CyBreach"]),
  removePodRep: vi.fn(async () => ({ removed: ["CyBreach M1 P2 Representative"], failed: ["CyBreach M2 P1 Representative"] })),
  listPodReps: vi.fn(() => [] as { memberId: string; project: string; module: number; pod: number }[]),
};
vi.mock("../src/services/leadership.js", () => svc);

const { rep, formatRepList } = await import("../src/commands/rep.js");

function fakeInteraction(sub: string, opts: Record<string, unknown> = {}) {
  const i = {
    user: { id: "hr" },
    inCachedGuild: () => true,
    guild: { members: { fetch: vi.fn(async (id: string) => ({ id })) } },
    deferred: false,
    reply: vi.fn(async () => {}),
    deferReply: vi.fn(async () => { i.deferred = true; }),
    editReply: vi.fn(async () => {}),
    options: {
      getSubcommand: () => sub,
      getUser: () => ({ id: "u1" }),
      getString: (k: string) => (opts[k] as string | undefined) ?? null,
      getInteger: (k: string) => (opts[k] as number | undefined) ?? null,
    },
  };
  return i;
}
const text = (fn: ReturnType<typeof vi.fn>) => {
  const arg = fn.mock.calls.at(-1)?.[0] as string | { content: string };
  return typeof arg === "string" ? arg : arg.content;
};

beforeEach(() => { vi.clearAllMocks(); canManage.mockReturnValue(true); });

describe("/rep permission gate", () => {
  it.each(["assign", "remove", "list"])("%s refuses without canManageLeadership and touches nothing", async (sub) => {
    canManage.mockReturnValue(false);
    const i = fakeInteraction(sub, { project: "cybreach", module: 1, pod: 2 });
    await rep.execute(i as never);
    expect(text(i.reply)).toBe("Not allowed.");
    expect(svc.assignPodRep).not.toHaveBeenCalled();
    expect(svc.removePodRep).not.toHaveBeenCalled();
    expect(svc.listPodReps).not.toHaveBeenCalled();
  });
});

describe("/rep assign | remove", () => {
  it("assign defers, then edits the reply", async () => {
    const i = fakeInteraction("assign", { project: "cybreach", module: 1, pod: 2 });
    await rep.execute(i as never);
    expect(i.deferReply).toHaveBeenCalled();
    expect(text(i.editReply)).toMatch(/CyBreach M1 P2 Representative/);
  });
  it("assign shows the service error (e.g. missing rep role)", async () => {
    svc.assignPodRep.mockRejectedValueOnce(new Error("Rep role missing — run /setup"));
    const i = fakeInteraction("assign", { project: "cybreach", module: 2, pod: 2 });
    await rep.execute(i as never);
    expect(text(i.editReply)).toBe("Rep role missing — run /setup");
  });
  it("remove defers and reports removed and failed role names", async () => {
    const i = fakeInteraction("remove", { project: "cybreach" });
    await rep.execute(i as never);
    expect(i.deferReply).toHaveBeenCalled();
    expect(svc.removePodRep).toHaveBeenCalledWith(expect.objectContaining({ projectKey: "cybreach", moduleNum: undefined, podNum: undefined }));
    const msg = text(i.editReply);
    expect(msg).toMatch(/Removed: CyBreach M1 P2 Representative/);
    expect(msg).toMatch(/Could not remove: CyBreach M2 P1 Representative/);
  });
  it("remove with nothing to remove says so; bad args show the error", async () => {
    svc.removePodRep.mockResolvedValueOnce({ removed: [], failed: [] });
    const i = fakeInteraction("remove");
    await rep.execute(i as never);
    expect(text(i.editReply)).toMatch(/no Pod Representative role/i);
    svc.removePodRep.mockRejectedValueOnce(new Error("Give a project together with module / pod."));
    const j = fakeInteraction("remove", { module: 1 });
    await rep.execute(j as never);
    expect(text(j.editReply)).toBe("Give a project together with module / pod.");
  });
});

describe("/rep list", () => {
  it("shows the project name, not the key", () => {
    expect(formatRepList([{ memberId: "u1", project: "cybreach", module: 1, pod: 2 }])).toBe("- <@u1> — CyBreach M1 P2");
  });
  it("stays under 2000 chars and says how many more", () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ memberId: `1234567890123456${i}`, project: "cybreach", module: 1, pod: 2 }));
    const out = formatRepList(many);
    expect(out.length).toBeLessThan(2000);
    const shown = out.split("\n").filter((l) => l.startsWith("- ")).length;
    expect(out).toMatch(new RegExp(`…and ${300 - shown} more$`));
  });
  it("empty list", () => {
    expect(formatRepList([])).toBe("No Pod Representatives.");
  });
});
