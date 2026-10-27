import { describe, it, expect, vi, beforeEach } from "vitest";

// Member.project stores the project NAME, and "EMS-managed" detection resolves it
// against org.json. A rename must move those rows too, or the renamed project's
// interns silently fall back under the bot's own auto-warnings/termination.
vi.mock("node:fs", async (orig) => ({ ...(await orig<typeof import("node:fs")>()), writeFileSync: vi.fn() }));
vi.mock("../src/core/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
const org = {
  projects: [{ key: "alpha", name: "Alpha", modules: 0, podsPerModule: 0, active: true, moduleChannels: false, moduleVoice: true }],
  categories: { archive: { name: "ARCHIVE" } },
};
vi.mock("../src/config/loader.js", () => ({ CONFIG_PATH: "/nowhere/org.json", org }));
vi.mock("../src/services/bootstrap.js", () => ({ bootstrapServer: vi.fn() }));
vi.mock("../src/services/commandSync.js", () => ({ syncGuildCommands: vi.fn(async () => {}) }));
const memberUpdateMany = vi.fn(async () => ({ count: 2 }));
vi.mock("../src/core/db.js", () => ({ prisma: { member: { updateMany: memberUpdateMany } } }));

const { renameProject } = await import("../src/services/projectMgmt.js");
const guild = { roles: { cache: new Map() }, channels: { cache: new Map() } } as never;

beforeEach(() => memberUpdateMany.mockClear());

describe("renameProject", () => {
  it("moves Member.project from the old name to the new one", async () => {
    await renameProject(guild, "alpha", "Alpha Prime");
    expect(memberUpdateMany).toHaveBeenCalledWith({ where: { project: "Alpha" }, data: { project: "Alpha Prime" } });
    expect(org.projects[0]!.name).toBe("Alpha Prime");
  });
});
