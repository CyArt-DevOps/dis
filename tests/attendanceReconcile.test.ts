import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/core/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

const findMany = vi.fn();
const update = vi.fn();
const create = vi.fn();
const upsert = vi.fn();
const executeRaw = vi.fn();
vi.mock("../src/core/db.js", () => ({
  prisma: { voiceSession: { findMany, update, create }, member: { upsert }, $executeRaw: executeRaw },
}));

const { reconcileVoiceSessions } = await import("../src/services/attendance.js");

function clientWith(channelId: string) {
  const vs = { id: "u1", channelId, member: { user: { bot: false } } };
  return { guilds: { cache: new Map([["g1", { id: "g1", voiceStates: { cache: new Map([["u1", vs]]) } }]]) } } as never;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-10T10:00:00Z"));
  for (const m of [findMany, update, create, upsert, executeRaw]) m.mockReset();
  upsert.mockResolvedValue({});
  update.mockResolvedValue({});
  create.mockResolvedValue({});
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
    expect(update).toHaveBeenCalledWith({ where: { id: 7 }, data: { creditedUpTo: now, seconds: 3600 } });
    expect(update).toHaveBeenCalledWith({ where: { id: 7 }, data: { leftAt: now } });
    expect(update.mock.calls.some(([a]) => "channelId" in a.data)).toBe(false);

    // new session starts at now in the actual channel
    expect(create).toHaveBeenCalledWith({ data: { guildId: "g1", userId: "u1", channelId: "new", joinedAt: now } });
    expect(res).toEqual({ opened: 1, closed: 1 });
  });

  it("leaves a session alone when the channel matches", async () => {
    findMany.mockResolvedValue([
      { id: 7, guildId: "g1", userId: "u1", channelId: "same", joinedAt: new Date("2026-03-10T09:00:00Z"), creditedUpTo: null, seconds: 0 },
    ]);
    expect(await reconcileVoiceSessions(clientWith("same"))).toEqual({ opened: 0, closed: 0 });
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
