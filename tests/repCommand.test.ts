import { describe, it, expect, vi, beforeEach } from "vitest";

// /rep command wiring (Phase 6 + sub-project C): permission gate (staff or the project's Team Lead), deferred replies,
// the Replace / Cancel prompt for an occupied pod, remove reasons, rep.changed events for EMS, and a /rep list that
// stays under Discord's 2000-char limit and shows project names.
const canManage = vi.fn(() => true);
const teamLeadOf = vi.fn((_m: unknown, _k: string) => false);
vi.mock("../src/lib/rbac.js", () => ({ canManageLeadership: () => canManage(), isProjectTeamLead: (m: unknown, k: string) => teamLeadOf(m, k) }));
const projects = [{ key: "cybreach", name: "CyBreach", modules: 2, podsPerModule: 2, active: true }, { key: "ai", name: "AI SIEM", modules: 1, podsPerModule: 1, active: true }];
vi.mock("../src/config/loader.js", () => ({ activeProjects: () => projects, org: { projects }, findProject: (k: string) => projects.find((p) => p.key === k) }));
const svc = {
  assignPodRep: vi.fn(async () => ["CyBreach M1 P2 Representative", "CyBreach"]),
  removePodRep: vi.fn(async () => ({ removed: ["CyBreach M1 P2 Representative"], failed: ["CyBreach M2 P1 Representative"] })),
  listPodReps: vi.fn(() => [] as { memberId: string; project: string; module: number; pod: number }[]),
  podRepHolders: vi.fn(() => [] as unknown[]),
};
vi.mock("../src/services/leadership.js", () => svc);
const enqueueEvent = vi.fn(async () => {});
vi.mock("../src/services/emsOutbox.js", () => ({ enqueueEvent }));

const { rep, formatRepList, REP_IDS } = await import("../src/commands/rep.js");

const roles = (...names: string[]) => ({ cache: new Map(names.map((name, i) => [`r${i}`, { id: `r${i}`, name }])) });
const TARGET = "210000000000000021";
const ACTOR = "800000000000000008";
function fakeInteraction(sub: string, opts: Record<string, unknown> = {}, click?: { customId: string } | "timeout") {
  const update = vi.fn(async () => {});
  const message = {
    awaitMessageComponent: vi.fn(async () => {
      if (click === "timeout" || !click) throw new Error("time");
      return { ...click, update };
    }),
  };
  const i = {
    user: { id: ACTOR },
    inCachedGuild: () => true,
    guild: {
      members: {
        fetch: vi.fn(async (id: string) => ({ id, roles: id === TARGET ? roles("CyBreach", "CyBreach Module 1 Pod 2", "CyBreach M1 P2 Representative") : roles("CyBreach Team Lead") })),
      },
    },
    deferred: false,
    reply: vi.fn(async () => {}),
    deferReply: vi.fn(async () => { i.deferred = true; }),
    editReply: vi.fn(async () => message),
    update,
    message,
    options: {
      getSubcommand: () => sub,
      getUser: () => ({ id: TARGET }),
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

beforeEach(() => { vi.clearAllMocks(); canManage.mockReturnValue(true); teamLeadOf.mockReturnValue(false); svc.podRepHolders.mockReturnValue([]); });

describe("/rep permission gate", () => {
  it.each(["assign", "remove", "list"])("%s refuses a member who is neither staff nor that project's Team Lead", async (sub) => {
    canManage.mockReturnValue(false);
    const i = fakeInteraction(sub, { project: "cybreach", module: 1, pod: 2, reason: "Stepping down" });
    await rep.execute(i as never);
    expect(text(i.reply)).toBe("Not allowed.");
    expect(svc.assignPodRep).not.toHaveBeenCalled();
    expect(svc.removePodRep).not.toHaveBeenCalled();
    expect(svc.listPodReps).not.toHaveBeenCalled();
  });
  it("RC-DIS-03: the project's Team Lead may assign; another project's Team Lead may not", async () => {
    canManage.mockReturnValue(false);
    teamLeadOf.mockImplementation((_m, k) => k === "cybreach");
    const mine = fakeInteraction("assign", { project: "cybreach", module: 1, pod: 2 });
    await rep.execute(mine as never);
    expect(svc.assignPodRep).toHaveBeenCalledTimes(1);
    const other = fakeInteraction("assign", { project: "ai", module: 1, pod: 1 });
    await rep.execute(other as never);
    expect(text(other.reply)).toBe("Not allowed.");
    expect(svc.assignPodRep).toHaveBeenCalledTimes(1);
  });
  it("RC-DIS-03: a Team Lead may only pick a member of that pod", async () => {
    canManage.mockReturnValue(false);
    teamLeadOf.mockReturnValue(true);
    const i = fakeInteraction("assign", { project: "cybreach", module: 2, pod: 1 });
    await rep.execute(i as never);
    expect(text(i.editReply)).toBe(`<@${TARGET}> is not in CyBreach M2 P1.`);
    expect(svc.assignPodRep).not.toHaveBeenCalled();
  });
  it("RC-DIS-03: a Team Lead cannot run a project-less /rep remove (every rep role) — staff only", async () => {
    canManage.mockReturnValue(false);
    teamLeadOf.mockReturnValue(true);
    const i = fakeInteraction("remove", { reason: "Stepping down" });
    await rep.execute(i as never);
    expect(text(i.reply)).toBe("Not allowed.");
    expect(svc.removePodRep).not.toHaveBeenCalled();
  });
});

describe("/rep assign | remove", () => {
  it("assign defers, then edits the reply and reports 'assigned' to EMS", async () => {
    const i = fakeInteraction("assign", { project: "cybreach", module: 1, pod: 2 });
    await rep.execute(i as never);
    expect(i.deferReply).toHaveBeenCalled();
    expect(text(i.editReply)).toMatch(/CyBreach M1 P2 Representative/);
    expect(svc.assignPodRep).toHaveBeenCalledWith(expect.objectContaining({ projectKey: "cybreach", moduleNum: 1, podNum: 2, replace: false }));
    expect(enqueueEvent).toHaveBeenCalledWith("rep.changed", expect.objectContaining({
      action: "assigned", discordUserId: TARGET, project: "cybreach", module: 1, pod: 2, source: "discord", actorDiscordId: ACTOR,
      leadership: { teamLeadOf: [], coLeadOf: [], podRepOf: [{ project: "cybreach", module: 1, pod: 2 }] },
    }));
  });
  it("RC-DIS-04: an occupied pod asks 'Replace @old?' with Replace / Cancel; Replace swaps and reports 'replaced'", async () => {
    svc.podRepHolders.mockReturnValue([{ id: "260000000000000026", roles: roles() }]);
    const i = fakeInteraction("assign", { project: "cybreach", module: 1, pod: 2 }, { customId: REP_IDS.replace });
    await rep.execute(i as never);
    const prompt = i.editReply.mock.calls[0]![0] as { content: string; components: { toJSON: () => { components: { custom_id: string; label: string }[] } }[] };
    expect(prompt.content).toBe("Replace <@260000000000000026> as CyBreach M1 P2 Representative?");
    expect(prompt.components[0]!.toJSON().components.map((c) => [c.custom_id, c.label])).toEqual([[REP_IDS.replace, "Replace"], [REP_IDS.cancel, "Cancel"]]);
    expect(svc.assignPodRep).toHaveBeenCalledWith(expect.objectContaining({ replace: true }));
    expect(enqueueEvent).toHaveBeenCalledWith("rep.changed", expect.objectContaining({
      action: "replaced", replacedDiscordUserId: "260000000000000026", replacedLeadership: { teamLeadOf: [], coLeadOf: [], podRepOf: [] },
    }));
  });
  it("RC-DIS-04: Cancel or no answer → nothing changed", async () => {
    svc.podRepHolders.mockReturnValue([{ id: "260000000000000026", roles: roles() }]);
    const c = fakeInteraction("assign", { project: "cybreach", module: 1, pod: 2 }, { customId: REP_IDS.cancel });
    await rep.execute(c as never);
    expect(c.update).toHaveBeenCalledWith({ content: "Cancelled — nothing changed.", components: [] });
    const t = fakeInteraction("assign", { project: "cybreach", module: 1, pod: 2 }, "timeout");
    await rep.execute(t as never);
    expect(text(t.editReply)).toBe("No answer — nothing changed.");
    expect(svc.assignPodRep).not.toHaveBeenCalled();
    expect(enqueueEvent).not.toHaveBeenCalled();
  });
  it("assign shows the service error (e.g. missing rep role)", async () => {
    svc.assignPodRep.mockRejectedValueOnce(new Error("Rep role missing — run /setup"));
    const i = fakeInteraction("assign", { project: "cybreach", module: 2, pod: 2 });
    await rep.execute(i as never);
    expect(text(i.editReply)).toBe("Rep role missing — run /setup");
    expect(enqueueEvent).not.toHaveBeenCalled();
  });
  it("remove defers, passes the reason, reports removed and failed role names and one 'removed' event per pod", async () => {
    const i = fakeInteraction("remove", { project: "cybreach", reason: " Moved pods " });
    await rep.execute(i as never);
    expect(i.deferReply).toHaveBeenCalled();
    expect(svc.removePodRep).toHaveBeenCalledWith(expect.objectContaining({ projectKey: "cybreach", moduleNum: undefined, podNum: undefined, reason: "Moved pods" }));
    const msg = text(i.editReply);
    expect(msg).toMatch(/Removed: CyBreach M1 P2 Representative/);
    expect(msg).toMatch(/Could not remove: CyBreach M2 P1 Representative/);
    expect(enqueueEvent).toHaveBeenCalledTimes(1);
    expect(enqueueEvent).toHaveBeenCalledWith("rep.changed", expect.objectContaining({ action: "removed", module: 1, pod: 2, reason: "Moved pods" }));
  });
  it("remove without a usable reason is refused; nothing to remove says so; bad args show the error", async () => {
    const r = fakeInteraction("remove", { project: "cybreach", reason: " a " });
    await rep.execute(r as never);
    expect(text(r.editReply)).toBe("Give a reason (at least 3 characters).");
    expect(svc.removePodRep).not.toHaveBeenCalled();
    svc.removePodRep.mockResolvedValueOnce({ removed: [], failed: [] });
    const i = fakeInteraction("remove", { reason: "Stepping down" });
    await rep.execute(i as never);
    expect(text(i.editReply)).toMatch(/no Pod Representative role/i);
    svc.removePodRep.mockRejectedValueOnce(new Error("Give a project together with module / pod."));
    const j = fakeInteraction("remove", { module: 1, reason: "Stepping down" });
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
