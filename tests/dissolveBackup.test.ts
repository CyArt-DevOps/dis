import { describe, it, expect, vi, beforeEach } from "vitest";

// Dissolve must save the message backup BEFORE deleting or kicking anything, tell
// EMS who is leaving before the kicks, and do nothing at all when the backup fails.
const order: string[] = [];
const writeFileSync = vi.fn((path: string) => {
  order.push(`write:${String(path).split(/[\\/]/).pop()}`);
});
vi.mock("node:fs", async (orig) => ({ ...(await orig<typeof import("node:fs")>()), writeFileSync, mkdirSync: vi.fn() }));
vi.mock("../src/core/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
const baseProjects = () => [
  { key: "alpha", name: "Alpha", modules: 0, podsPerModule: 0, active: true, moduleChannels: false, moduleVoice: true },
  { key: "beta", name: "Beta", modules: 0, podsPerModule: 0, active: true, moduleChannels: false, moduleVoice: true },
];
const org = { projects: baseProjects(), categories: { archive: { name: "ARCHIVE" } }, roles: { admin: ["Founder", "Manager", "HR"] } };
vi.mock("../src/config/loader.js", () => ({ CONFIG_PATH: "/nowhere/org.json", org, findProject: () => undefined }));
vi.mock("../src/services/bootstrap.js", () => ({ bootstrapServer: vi.fn() }));
vi.mock("../src/services/commandSync.js", () => ({ syncGuildCommands: vi.fn(async () => {}) }));
const findMany = vi.fn(async () => [
  { id: "db1", project: " alpha " },
  { id: "x9", project: "Beta" },
]);
const updateMany = vi.fn(async () => {
  order.push("db:former");
  return { count: 0 };
});
vi.mock("../src/core/db.js", () => ({ prisma: { member: { findMany, updateMany } } }));
const enqueueEventStrict = vi.fn(async (type: string) => void order.push(`event:${type}`));
vi.mock("../src/services/emsOutbox.js", () => ({ enqueueEventStrict }));
let integrationOn = true;
vi.mock("../src/services/emsClient.js", () => ({ integrationEnabled: () => integrationOn }));
const collect = vi.fn();
vi.mock("../src/services/messageBackup.js", async (orig) => ({
  ...(await orig<typeof import("../src/services/messageBackup.js")>()),
  collectProjectMessages: collect,
}));

const { dissolveProject } = await import("../src/services/projectMgmt.js");
const { BackupError } = await import("../src/services/messageBackup.js");
const { ChannelType, PermissionsBitField } = await import("discord.js");

function filterable<K, V>(m: Map<K, V>) {
  return Object.assign(m, { filter: (f: (v: V) => boolean) => [...m.values()].filter(f) });
}

function member(id: string, roles: string[], opts: { bot?: boolean; failKick?: boolean } = {}) {
  return {
    id,
    user: { tag: `user${id}`, bot: Boolean(opts.bot) },
    guild: { ownerId: "owner" },
    permissions: new PermissionsBitField(0n),
    roles: {
      cache: Object.assign(new Map(roles.map((r, i) => [`${id}-${i}`, { name: r }])), {
        some(this: Map<string, { name: string }>, f: (r: { name: string }) => boolean) {
          return [...this.values()].some(f);
        },
      }),
    },
    kick: vi.fn(async () => {
      if (opts.failKick) throw new Error("Missing Permissions");
      order.push(`kick:${id}`);
    }),
  };
}

let members: ReturnType<typeof member>[] = [];

function guild() {
  const del = (name: string) => vi.fn(async () => void order.push(`delete:${name}`));
  const cat = { id: "1", name: "ALPHA", type: ChannelType.GuildCategory, parent: null, delete: del("ALPHA") };
  const ch = { id: "2", name: "general", type: ChannelType.GuildText, parent: cat, delete: del("general") };
  const role = { id: "r", name: "Alpha", color: 0, delete: del("role:Alpha") };
  return {
    id: "g1",
    channels: { cache: filterable(new Map<string, unknown>([["1", cat], ["2", ch]])) },
    roles: { cache: filterable(new Map([["r", role]])) },
    members: { fetch: vi.fn(async () => new Map(members.map((m) => [m.id, m]))) },
  } as never;
}

beforeEach(() => {
  order.length = 0;
  collect.mockReset();
  writeFileSync.mockClear();
  enqueueEventStrict.mockReset();
  enqueueEventStrict.mockImplementation(async (type: string) => void order.push(`event:${type}`));
  integrationOn = true;
  updateMany.mockClear();
  org.projects = baseProjects();
  members = [
    member("i1", ["Alpha"]),
    member("tl", ["Alpha Team Lead"]),
    member("db1", []),
    member("hr", ["Alpha", "HR"]),
    member("b", ["Alpha"], { bot: true }),
    member("both", ["Alpha", "Beta"]),
    member("other", ["Beta"]),
    member("bad", ["Alpha"], { failKick: true }),
  ];
  collect.mockResolvedValue({ project: "Alpha", dissolvedAt: new Date().toISOString(), dissolvedBy: "f", channels: [], authors: {} });
});

describe("dissolveProject", () => {
  it("writes the message backup before deleting anything", async () => {
    const res = await dissolveProject(guild(), "alpha", { actorTag: "founder" });
    const firstDelete = order.findIndex((s) => s.startsWith("delete:"));
    const htmlWrite = order.findIndex((s) => /^write:Alpha-messages-.*\.html$/.test(s));
    expect(htmlWrite).toBeGreaterThanOrEqual(0);
    expect(htmlWrite).toBeLessThan(firstDelete);
    expect(res.messagesFile).toMatch(/Alpha-messages-\d{4}-\d{2}-\d{2}-\d{6}\.html$/);
    expect(res.messagesBytes).toBeGreaterThan(0);
    expect(collect).toHaveBeenCalledWith(expect.anything(), expect.any(Set), expect.objectContaining({ project: "Alpha", dissolvedBy: "founder" }));
    expect(org.projects.map((p) => p.key)).toEqual(["beta"]);
  });

  it("kicks project members (roles + DB), skips staff/bots/other-project, and reports failures", async () => {
    const progress = vi.fn();
    const res = await dissolveProject(guild(), "alpha", { onKickProgress: progress });
    expect(res.kicked.sort()).toEqual(["userdb1", "useri1", "usertl"]);
    expect(res.kickFailed).toEqual([{ tag: "userbad", error: "Missing Permissions" }]);
    expect(res.skipped.map((s) => `${s.id}:${s.reason}`).sort()).toEqual(["b:bot", "both:other project", "hr:staff"]);
    expect(members.find((m) => m.id === "other")!.kick).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith(4, 4);
  });

  it("tells EMS only about members really kicked, after the kicks, and marks only them former", async () => {
    const res = await dissolveProject(guild(), "alpha", {});
    expect(res.ems).toBe("queued");
    expect(enqueueEventStrict).toHaveBeenCalledTimes(1);
    const data = enqueueEventStrict.mock.calls[0]![1] as { key: string; memberIds: string[] };
    expect(data.key).toBe("alpha");
    expect([...data.memberIds].sort()).toEqual(["db1", "i1", "tl"]);
    const ev = order.indexOf("event:project.dissolved");
    const lastKick = order.map((s) => s.startsWith("kick:")).lastIndexOf(true);
    expect(ev).toBeGreaterThan(lastKick);
    expect(order.indexOf("db:former")).toBeLessThan(order.findIndex((s) => s.startsWith("delete:")));
    const upd = updateMany.mock.calls[0]![0] as unknown as { where: { id: { in: string[] } }; data: Record<string, unknown> };
    expect([...upd.where.id.in].sort()).toEqual(["db1", "i1", "tl"]);
    expect(upd.data).toMatchObject({ status: "former", project: null, module: null, pod: null, formerReason: "Project Alpha dissolved" });
    // the plan was written to disk before the first kick
    const plan = order.findIndex((s) => /^write:dissolve-members-alpha-/.test(s));
    expect(plan).toBeGreaterThanOrEqual(0);
    expect(plan).toBeLessThan(order.findIndex((s) => s.startsWith("kick:")));
  });

  it("reports EMS off or failed instead of silently losing the event", async () => {
    integrationOn = false;
    expect((await dissolveProject(guild(), "alpha", {})).ems).toBe("off");
    expect(enqueueEventStrict).not.toHaveBeenCalled();
    integrationOn = true;
    org.projects = baseProjects();
    enqueueEventStrict.mockRejectedValue(new Error("db down"));
    expect((await dissolveProject(guild(), "alpha", {})).ems).toBe("failed");
    expect(enqueueEventStrict).toHaveBeenCalledTimes(3);
  });

  it("stops before anything is deleted when the member list cannot be loaded", async () => {
    const g = guild() as unknown as { members: { fetch: () => Promise<never> } };
    g.members.fetch = async () => {
      throw new Error("timeout");
    };
    await expect(dissolveProject(g as never, "alpha", {})).rejects.toThrow(BackupError);
    expect(order.filter((s) => s.startsWith("delete:") || s.startsWith("kick:"))).toEqual([]);
    expect(org.projects).toHaveLength(2);
  });

  it("refuses a second dissolve of the same project while one runs", async () => {
    let release!: () => void;
    collect.mockImplementationOnce(() => new Promise((r) => (release = () => r({ project: "Alpha", dissolvedAt: "", dissolvedBy: "", channels: [], authors: {} }))));
    const first = dissolveProject(guild(), "alpha", {});
    await expect(dissolveProject(guild(), "alpha", {})).rejects.toThrow(/already being dissolved/);
    release();
    await first;
  });

  it("does nothing at all when the backup fails", async () => {
    collect.mockRejectedValue(new BackupError("Cannot read #secret"));
    await expect(dissolveProject(guild(), "alpha", {})).rejects.toThrow("Cannot read #secret");
    expect(order).toEqual([]);
    expect(enqueueEventStrict).not.toHaveBeenCalled();
    expect(org.projects).toHaveLength(2);
  });
});
