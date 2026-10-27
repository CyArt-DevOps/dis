import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const upsert = vi.fn();
vi.mock("../src/core/db.js", () => ({ prisma: { botSetting: { findUnique, upsert } } }));

const { parseAutoWarn, autoWarnOff, getAutoWarn, setAutoWarn, resetAutoWarnCacheForTests } = await import("../src/services/autoWarn.js");

const projects = [{ key: "alpha", name: "Alpha Project" }, { key: "beta", name: "Beta" }];

beforeEach(() => {
  findUnique.mockReset();
  upsert.mockReset();
  resetAutoWarnCacheForTests();
});

describe("parseAutoWarn", () => {
  it("defaults to nothing disabled on missing or bad JSON", () => {
    expect(parseAutoWarn(null)).toEqual({ disabledProjects: [] });
    expect(parseAutoWarn("{nope")).toEqual({ disabledProjects: [] });
    expect(parseAutoWarn('{"disabledProjects":5}')).toEqual({ disabledProjects: [] });
  });
  it("keeps 'all' and a de-duplicated list of keys", () => {
    expect(parseAutoWarn('{"disabledProjects":"all"}')).toEqual({ disabledProjects: "all" });
    expect(parseAutoWarn('{"disabledProjects":["alpha","alpha","",3]}')).toEqual({ disabledProjects: ["alpha"] });
  });
});

describe("autoWarnOff", () => {
  it("matches the member's project by key or by name", () => {
    const s = { disabledProjects: ["alpha"] };
    expect(autoWarnOff(s, "alpha", projects)).toBe(true);
    expect(autoWarnOff(s, "Alpha Project", projects)).toBe(true);
    expect(autoWarnOff(s, "Beta", projects)).toBe(false);
    expect(autoWarnOff(s, null, projects)).toBe(false);
  });
  it("'all' covers everyone, an empty list no one", () => {
    expect(autoWarnOff({ disabledProjects: "all" }, null, projects)).toBe(true);
    expect(autoWarnOff({ disabledProjects: [] }, "alpha", projects)).toBe(false);
  });
});

describe("getAutoWarn / setAutoWarn", () => {
  it("reads BotSetting once a minute", async () => {
    findUnique.mockResolvedValue({ key: "autoWarn", value: '{"disabledProjects":["beta"]}' });
    expect(await getAutoWarn(1000)).toEqual({ disabledProjects: ["beta"] });
    expect(await getAutoWarn(30_000)).toEqual({ disabledProjects: ["beta"] });
    expect(findUnique).toHaveBeenCalledTimes(1);
    await getAutoWarn(70_000);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });
  it("set upserts clean JSON and refreshes the cache", async () => {
    upsert.mockResolvedValue({});
    expect(await setAutoWarn({ disabledProjects: ["alpha", "alpha"] }, 1000)).toEqual({ disabledProjects: ["alpha"] });
    expect(upsert.mock.calls[0]![0]).toEqual({
      where: { key: "autoWarn" },
      create: { key: "autoWarn", value: '{"disabledProjects":["alpha"]}' },
      update: { value: '{"disabledProjects":["alpha"]}' },
    });
    expect(await getAutoWarn(2000)).toEqual({ disabledProjects: ["alpha"] });
    expect(findUnique).not.toHaveBeenCalled();
  });
});
