import { describe, it, expect, vi, beforeEach } from "vitest";

// The hours sweep and the absence escalations must leave members of EMS-managed
// projects alone; everyone else keeps the bot's existing behaviour.
vi.mock("../src/core/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("../src/config/loader.js", () => ({
  org: {
    timezone: "Asia/Kolkata",
    projects: [{ key: "alpha", name: "Alpha" }, { key: "beta", name: "Beta" }],
    attendancePolicy: { windowEnd: "17:30", minHours: 5, loginBy: "14:00", trackingStartsOn: undefined },
    enforcement: { mode: "strict", consecutiveShortDays: 2, ackHours: 24, strikeLimit: 3, startsOn: undefined },
  },
}));
const warnCreate = vi.fn(async ({ data }: { data: { userId: string } }) => ({ id: 1, ...data }));
const warnFindMany = vi.fn(async () => []);
const warnGroupBy = vi.fn(async () => []);
vi.mock("../src/core/db.js", () => ({
  prisma: {
    warn: { create: warnCreate, findMany: warnFindMany, groupBy: warnGroupBy, findUnique: vi.fn(async () => null) },
    member: { findMany: vi.fn(async () => []) },
    termination: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("../src/core/botClient.js", () => ({ botClient: () => null, botGuild: () => null }));
vi.mock("../src/services/notify.js", () => ({ notifyMember: vi.fn() }));
const cals = [
  { userId: "u-alpha", project: "alpha", days: [] },
  { userId: "u-beta", project: "Beta", days: [] },
];
vi.mock("../src/services/calendar.js", () => ({ buildCalendars: vi.fn(async () => cals) }));
vi.mock("../src/lib/streak.js", () => ({
  shortStreak: vi.fn(() => [{ day: "2026-10-26", absent: true, seconds: 0 }, { day: "2026-10-27", absent: true, seconds: 0 }]),
}));
let setting = '{"disabledProjects":["alpha"]}';
vi.mock("../src/services/autoWarn.js", async (orig) => {
  const real = await orig<typeof import("../src/services/autoWarn.js")>();
  return { ...real, getAutoWarn: vi.fn(async () => real.parseAutoWarn(setting)) };
});
const countAbsences = vi.fn(async () => 3);
vi.mock("../src/services/attendanceStats.js", () => ({ countAbsences }));
const send = vi.fn(async () => ({}));
vi.mock("../src/services/leave.js", () => ({ attendanceReportsChannel: () => ({ send }) }));

const { runHoursSweep } = await import("../src/services/warnings.js");
const { runEscalations } = await import("../src/services/escalation.js");

beforeEach(() => {
  warnCreate.mockClear();
  send.mockClear();
  countAbsences.mockClear();
});

describe("runHoursSweep with the auto-warn switch", () => {
  it("drafts no hours warning for a disabled project and counts it as emsManaged", async () => {
    setting = '{"disabledProjects":["alpha"]}';
    const out = await runHoursSweep("g1");
    expect(out).toMatchObject({ checked: 1, created: 1, emsManaged: 1 });
    expect(warnCreate).toHaveBeenCalledTimes(1);
    expect(warnCreate.mock.calls[0]![0].data.userId).toBe("u-beta");
  });
  it("'all' skips everyone; an empty list skips no one", async () => {
    setting = '{"disabledProjects":"all"}';
    expect(await runHoursSweep("g1")).toMatchObject({ checked: 0, created: 0, emsManaged: 2 });
    setting = '{"disabledProjects":[]}';
    expect(await runHoursSweep("g1")).toMatchObject({ checked: 2, created: 2, emsManaged: 0 });
  });
});

describe("runEscalations with the auto-warn switch", () => {
  const guild = { id: "g1", roles: { cache: { find: () => undefined } } } as never;
  const absentee = (userId: string, project: string) => ({ userId, fullName: userId, batch: null, project, module: 1, pod: 1 });
  it("posts no escalation for a member of a disabled project", async () => {
    setting = '{"disabledProjects":["alpha"]}';
    await runEscalations(guild, [absentee("u-alpha", "alpha"), absentee("u-beta", "beta")]);
    expect(countAbsences).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("posts for everyone when nothing is disabled", async () => {
    setting = '{"disabledProjects":[]}';
    await runEscalations(guild, [absentee("u-alpha", "alpha"), absentee("u-beta", "beta")]);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
