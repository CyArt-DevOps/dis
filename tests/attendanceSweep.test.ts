import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/core/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

interface Row {
  id: number;
  guildId: string;
  userId: string;
  channelId: string;
  joinedAt: Date;
  leftAt: Date | null;
  creditedUpTo: Date | null;
  seconds: number | null;
}

// An in-memory VoiceSession + Attendance. Every call yields first, as a remote
// database does, which is what lets concurrent sweeps interleave.
let rows: Row[] = [];
let credited = 0;
let inFlight = 0;
let maxInFlight = 0;
const tick = async () => {
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await Promise.resolve();
  await Promise.resolve();
  inFlight--;
};
const sameTime = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

const voiceSession = {
  findMany: vi.fn(async () => {
    await tick();
    return rows.filter((r) => r.leftAt === null).map((r) => ({ ...r }));
  }),
  findUnique: vi.fn(async ({ where }: { where: { id: number } }) => {
    await tick();
    const r = rows.find((x) => x.id === where.id);
    return r ? { ...r } : null;
  }),
  update: vi.fn(async ({ where, data }: { where: { id: number }; data: Partial<Row> }) => {
    await tick();
    Object.assign(rows.find((x) => x.id === where.id)!, data);
    return {};
  }),
  updateMany: vi.fn(
    async ({ where, data }: { where: { id: number; creditedUpTo: Date | null; leftAt: null }; data: { creditedUpTo: Date; seconds: number } }) => {
      await tick();
      const r = rows.find((x) => x.id === where.id);
      if (!r || r.leftAt !== null || !sameTime(r.creditedUpTo, where.creditedUpTo)) return { count: 0 };
      Object.assign(r, data);
      return { count: 1 };
    }
  ),
  create: vi.fn(),
};

vi.mock("../src/core/db.js", () => ({
  prisma: {
    voiceSession,
    member: { upsert: vi.fn(async () => ({})) },
    // Tagged template: (strings, guildId, userId, day, seconds, ...).
    $executeRaw: vi.fn(async (_s: TemplateStringsArray, _g: string, _u: string, _d: string, seconds: number) => {
      await tick();
      credited += seconds;
      return 1;
    }),
  },
}));

const { flushOpenSessions, runAttendanceSweep, closeAllOpenSessions } = await import("../src/services/attendance.js");

const T0 = new Date("2026-03-10T06:00:00Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
const session = (id: number): Row => ({
  id,
  guildId: "g1",
  userId: "u" + id,
  channelId: "c1",
  joinedAt: T0,
  leftAt: null,
  creditedUpTo: null,
  seconds: 0,
});
const emptyClient = (ids: number[]) =>
  ({
    guilds: {
      cache: new Map([
        [
          "g1",
          {
            id: "g1",
            voiceStates: {
              cache: new Map(ids.map((i) => ["u" + i, { id: "u" + i, channelId: "c1", member: { user: { bot: false } } }])),
            },
          },
        ],
      ]),
    },
  }) as never;

beforeEach(() => {
  vi.useFakeTimers();
  rows = [];
  credited = 0;
  inFlight = 0;
  maxInFlight = 0;
});
afterEach(() => vi.useRealTimers());

describe("voice credit under concurrency", () => {
  it("credits a span once when two flushes read the same rows", async () => {
    rows = [session(1), session(2), session(3)];
    vi.setSystemTime(at(60));
    await Promise.all([flushOpenSessions(), flushOpenSessions()]);
    expect(credited).toBe(180); // 3 members x 60s, not 360
    expect(rows.map((r) => r.seconds)).toEqual([60, 60, 60]);
  });

  it("never lets a slow older flush move the mark backwards or re-credit", async () => {
    rows = [session(1)];
    vi.setSystemTime(at(60));
    const older = flushOpenSessions(); // reads now=60 ...
    vi.setSystemTime(at(120));
    const newer = flushOpenSessions(); // ... and overlaps with now=120
    await Promise.all([older, newer]);
    vi.setSystemTime(at(180));
    await flushOpenSessions();
    expect(credited).toBe(180); // exactly the 180s that really passed
    expect(rows[0]!.seconds).toBe(180);
    expect(rows[0]!.creditedUpTo).toEqual(at(180));
  });

  it("a session closed from a stale row still credits its tail, once", async () => {
    rows = [session(1)];
    vi.setSystemTime(at(60));
    await flushOpenSessions();
    // Shutdown closes from its own read while a flush is also running.
    vi.setSystemTime(at(90));
    await Promise.all([flushOpenSessions(), closeAllOpenSessions()]);
    expect(credited).toBe(90);
    expect(rows[0]!.leftAt).toEqual(at(90));
  });
});

describe("runAttendanceSweep", () => {
  it("skips a tick while the previous sweep is still running", async () => {
    rows = [session(1)];
    vi.setSystemTime(at(60));
    const client = emptyClient([1]);
    const first = runAttendanceSweep(client);
    const second = runAttendanceSweep(client);
    expect(await second).toBe(false);
    expect(await first).toBe(true);
    expect(credited).toBe(60);
  });

  it("runs again once the previous sweep has finished, even if it failed", async () => {
    rows = [session(1)];
    vi.setSystemTime(at(60));
    const client = emptyClient([1]);
    voiceSession.findMany.mockRejectedValueOnce(new Error("db down"));
    expect(await runAttendanceSweep(client)).toBe(true);
    expect(await runAttendanceSweep(client)).toBe(true);
    expect(credited).toBe(60);
  });

  it("flushes members in parallel so a full server fits inside the interval", async () => {
    rows = Array.from({ length: 50 }, (_, i) => session(i + 1));
    vi.setSystemTime(at(60));
    await flushOpenSessions();
    expect(credited).toBe(3000);
    expect(maxInFlight).toBeGreaterThan(1);
  });
});
