import { describe, it, expect, vi, beforeEach } from "vitest";

// Member.project stores the project NAME, and "EMS-managed" detection resolves it
// against org.json. A rename must move those rows too, or the renamed project's
// interns silently fall back under the bot's own auto-warnings/termination.
vi.mock("node:fs", async (orig) => ({ ...(await orig<typeof import("node:fs")>()), writeFileSync: vi.fn() }));
vi.mock("../src/core/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
const org = {
  projects: [
    { key: "alpha", name: "Alpha", modules: 0, podsPerModule: 0, active: true, moduleChannels: false, moduleVoice: true },
    { key: "beta", name: "Beta", modules: 0, podsPerModule: 0, active: true, moduleChannels: false, moduleVoice: true },
  ],
  categories: { archive: { name: "ARCHIVE" } },
};
vi.mock("../src/config/loader.js", () => ({ CONFIG_PATH: "/nowhere/org.json", org }));
vi.mock("../src/services/bootstrap.js", () => ({ bootstrapServer: vi.fn() }));
vi.mock("../src/services/commandSync.js", () => ({ syncGuildCommands: vi.fn(async () => {}) }));
let distinctProjects: (string | null)[] = [];
const memberUpdateMany = vi.fn(async (_args: unknown) => ({ count: 2 }));
const memberFindMany = vi.fn(async (_args: unknown) => distinctProjects.map((project) => ({ project })));
vi.mock("../src/core/db.js", () => ({ prisma: { member: { updateMany: memberUpdateMany, findMany: memberFindMany } } }));

const { renameProject } = await import("../src/services/projectMgmt.js");
const guild = { id: "g1", roles: { cache: new Map() }, channels: { cache: new Map() } } as never;

beforeEach(() => {
  memberUpdateMany.mockClear();
  memberFindMany.mockClear();
  org.projects[0]!.name = "Alpha";
  distinctProjects = ["Alpha"];
});

function movedValues(): string[] {
  const args = memberUpdateMany.mock.calls[0]![0] as { where: { project: { in: string[] } } };
  return [...args.where.project.in].sort();
}

describe("renameProject", () => {
  it("moves Member.project from the old name to the new one", async () => {
    await renameProject(guild, "alpha", "Alpha Prime");
    expect(memberFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { guildId: "g1" }, distinct: ["project"] })
    );
    expect(memberUpdateMany).toHaveBeenCalledWith({
      where: { guildId: "g1", project: { in: ["Alpha"] } },
      data: { project: "Alpha Prime" },
    });
    expect(org.projects[0]!.name).toBe("Alpha Prime");
  });

  it("also moves whitespace, case and key-form variants, leaving other projects alone", async () => {
    distinctProjects = ["Alpha", " Alpha ", "ALPHA", "alpha", " ALPHA\t", "Beta", "beta ", null, "Gamma"];
    await renameProject(guild, "alpha", "Alpha Prime");
    expect(memberUpdateMany).toHaveBeenCalledTimes(1);
    expect(movedValues()).toEqual([" ALPHA\t", " Alpha ", "ALPHA", "Alpha", "alpha"].sort());
    expect(movedValues()).not.toContain("Beta");
    expect(movedValues()).not.toContain("beta ");
    expect(movedValues()).not.toContain("Gamma");
  });

  it("matches a renamed project whose name differs from its key", async () => {
    org.projects[0]!.name = "Project Apollo";
    distinctProjects = ["project apollo ", "  ALPHA", "Beta"];
    await renameProject(guild, "alpha", "Apollo II");
    expect(movedValues()).toEqual(["  ALPHA", "project apollo "].sort());
  });

  it("skips the update when no member rows match", async () => {
    distinctProjects = ["Beta", null];
    await renameProject(guild, "alpha", "Alpha Prime");
    expect(memberUpdateMany).not.toHaveBeenCalled();
  });
});
