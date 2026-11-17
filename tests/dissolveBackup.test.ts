import { describe, it, expect, vi, beforeEach } from "vitest";

// Dissolve must save the message backup BEFORE deleting anything, and delete
// nothing at all when the backup fails.
const order: string[] = [];
const writeFileSync = vi.fn((path: string) => {
  order.push(`write:${String(path).split(/[\\/]/).pop()}`);
});
vi.mock("node:fs", async (orig) => ({ ...(await orig<typeof import("node:fs")>()), writeFileSync, mkdirSync: vi.fn() }));
vi.mock("../src/core/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
const org = {
  projects: [{ key: "alpha", name: "Alpha", modules: 0, podsPerModule: 0, active: true, moduleChannels: false, moduleVoice: true }],
  categories: { archive: { name: "ARCHIVE" } },
};
vi.mock("../src/config/loader.js", () => ({ CONFIG_PATH: "/nowhere/org.json", org }));
vi.mock("../src/services/bootstrap.js", () => ({ bootstrapServer: vi.fn() }));
vi.mock("../src/services/commandSync.js", () => ({ syncGuildCommands: vi.fn(async () => {}) }));
vi.mock("../src/core/db.js", () => ({ prisma: {} }));
const collect = vi.fn();
vi.mock("../src/services/messageBackup.js", async (orig) => ({
  ...(await orig<typeof import("../src/services/messageBackup.js")>()),
  collectProjectMessages: collect,
}));

const { dissolveProject } = await import("../src/services/projectMgmt.js");
const { BackupError } = await import("../src/services/messageBackup.js");
const { ChannelType } = await import("discord.js");

function guild() {
  const del = (name: string) => vi.fn(async () => void order.push(`delete:${name}`));
  const cat = { id: "1", name: "ALPHA", type: ChannelType.GuildCategory, parent: null, delete: del("ALPHA") };
  const ch = { id: "2", name: "general", type: ChannelType.GuildText, parent: cat, delete: del("general") };
  const role = { id: "r", name: "Alpha", color: 0, delete: del("role:Alpha") };
  return {
    channels: { cache: new Map<string, unknown>([["1", cat], ["2", ch]]) },
    roles: { cache: Object.assign(new Map([["r", role]]), { filter: (f: (r: unknown) => boolean) => [role].filter(f) }) },
  };
}
function withFilter(g: ReturnType<typeof guild>) {
  const c = g.channels.cache as Map<string, unknown> & { filter?: unknown };
  c.filter = (f: (x: unknown) => boolean) => [...c.values()].filter(f);
  return g as never;
}

beforeEach(() => {
  order.length = 0;
  collect.mockReset();
  writeFileSync.mockClear();
  org.projects = [{ key: "alpha", name: "Alpha", modules: 0, podsPerModule: 0, active: true, moduleChannels: false, moduleVoice: true }];
});

describe("dissolveProject message backup", () => {
  it("writes the message backup before deleting anything", async () => {
    collect.mockResolvedValue({ project: "Alpha", dissolvedAt: new Date().toISOString(), dissolvedBy: "f", channels: [], authors: {} });
    const res = await dissolveProject(withFilter(guild()), "alpha", { actorTag: "founder" });
    const firstDelete = order.findIndex((s) => s.startsWith("delete:"));
    const htmlWrite = order.findIndex((s) => /^write:Alpha-messages-.*\.html$/.test(s));
    expect(htmlWrite).toBeGreaterThanOrEqual(0);
    expect(htmlWrite).toBeLessThan(firstDelete);
    expect(res.messagesFile).toMatch(/Alpha-messages-\d{4}-\d{2}-\d{2}-\d{6}\.html$/);
    expect(res.messagesBytes).toBeGreaterThan(0);
    expect(collect).toHaveBeenCalledWith(expect.anything(), expect.any(Set), expect.objectContaining({ project: "Alpha", dissolvedBy: "founder" }));
    expect(org.projects).toHaveLength(0);
  });

  it("deletes nothing and keeps the project when the backup fails", async () => {
    collect.mockRejectedValue(new BackupError("Cannot read #secret"));
    await expect(dissolveProject(withFilter(guild()), "alpha", {})).rejects.toThrow("Cannot read #secret");
    expect(order.filter((s) => s.startsWith("delete:"))).toEqual([]);
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(org.projects).toHaveLength(1);
  });
});
