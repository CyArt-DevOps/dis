import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/core/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

const findMany = vi.fn();
const update = vi.fn();
const updateMany = vi.fn();
const create = vi.fn();
const createMany = vi.fn();
const memberCreateMany = vi.fn();
const upsert = vi.fn();
const executeRaw = vi.fn();
vi.mock("../src/core/db.js", () => ({
  prisma: { voiceSession: { findMany, update, updateMany, create, createMany }, member: { upsert, createMany: memberCreateMany }, $executeRaw: executeRaw },
}));

const { reconcileVoiceSessions, closeStaleSessionsOnBoot } = await import("../src/services/attendance.js");

function clientWith(channelId: string) {
  const vs = { id: "u1", channelId, member: { user: { bot: false } } };
  return { guilds: { cache: new Map([["g1", { id: "g1", voiceStates: { cache: new Map([["u1", vs]]) } }]]) } } as never;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-10T10:00:00Z"));
  for (const m of [findMany, update, updateMany, create, createMany, memberCreateMany, upsert, executeRaw]) m.mockReset();
  upsert.mockResolvedValue({});
  update.mockResolvedValue({});
  updateMany.mockResolvedValue({ count: 1 });
  create.mockResolvedValue({});
  createMany.mockResolvedValue({ count: 1 });
  memberCreateMany.mockResolvedValue({ count: 0 });
  executeRaw.mockResolvedValue(1);
});

describe("reconcileVoiceSessions: missed channel move", () => {
  it("closes the old-channel session at now (crediting it) and opens a new one in the actual channel", async () => {
    findMany.mockResolvedValue([
      { id: 7, guildId: "g1", userId: "u1", channelId: "old", joinedAt: new Date("2026-03-10T09:00:00Z"), creditedUpTo: null, seconds: 0 },
    ]);
    const res = await reconcileVoiceSessions(clientWith("new"));
    const now = new Date("2026-03-10T10:00:00Z");

    // old session credited 1h and closed at now; channelId never rewritten
    expect(executeRaw).toHaveBeenCalled();
    expect(executeRaw.mock.calls[0]).toContain(3600);
    expect(updateMany).toHaveBeenCalledWith({ where: { id: 7, creditedUpTo: null, leftAt: null }, data: { creditedUpTo: now, seconds: 3600 } });
    expect(update).toHaveBeenCalledWith({ where: { id: 7 }, data: { leftAt: now } });
    expect(update.mock.calls.some(([a]) => "channelId" in a.data)).toBe(false);

    // new session starts at now in the actual channel
    expect(memberCreateMany).toHaveBeenCalledWith({ data: [{ id: "u1", guildId: "g1" }], skipDuplicates: true });
    expect(createMany).toHaveBeenCalledWith({ data: [{ guildId: "g1", userId: "u1", channelId: "new", joinedAt: now }] });
    expect(res).toEqual({ opened: 1, closed: 1 });
  });

  it("leaves a session alone when the channel matches", async () => {
    findMany.mockResolvedValue([
      { id: 7, guildId: "g1", userId: "u1", channelId: "same", joinedAt: new Date("2026-03-10T09:00:00Z"), creditedUpTo: null, seconds: 0 },
    ]);
    expect(await reconcileVoiceSessions(clientWith("same"))).toEqual({ opened: 0, closed: 0 });
    expect(update).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });
});

describe("reconcileVoiceSessions: boot with a full server", () => {
  it("opens every untracked member in bulk, not one round trip each", async () => {
    findMany.mockResolvedValue([]);
    const states = new Map(
      Array.from({ length: 250 }, (_, i) => ["u" + i, { id: "u" + i, channelId: "c1", member: { user: { bot: false } } }])
    );
    const client = { guilds: { cache: new Map([["g1", { id: "g1", voiceStates: { cache: states } }]]) } } as never;
    expect(await reconcileVoiceSessions(client)).toEqual({ opened: 250, closed: 0 });
    expect(createMany).toHaveBeenCalledTimes(2); // 200 + 50
    expect(memberCreateMany).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("closeStaleSessionsOnBoot", () => {
  it("closes every open session in ONE statement at its checkpoint (no per-row round trips)", async () => {
    executeRaw.mockResolvedValue(275);
    expect(await closeStaleSessionsOnBoot()).toBe(275);
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const sql = (executeRaw.mock.calls[0][0] as TemplateStringsArray).join("?");
    expect(sql).toMatch(/UPDATE\s+`VoiceSession`/);
    expect(sql).toMatch(/`leftAt`\s*=\s*COALESCE\(`creditedUpTo`,\s*`joinedAt`\)/);
    expect(sql).toMatch(/`seconds`\s*=\s*COALESCE\(`seconds`,\s*0\)/);
    expect(sql).toMatch(/WHERE\s+`leftAt`\s+IS\s+NULL/);
    expect(findMany).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("returns 0 when nothing was open", async () => {
    executeRaw.mockResolvedValue(0);
    expect(await closeStaleSessionsOnBoot()).toBe(0);
  });
});
