import { describe, it, expect, vi, beforeEach } from "vitest";

// The hours sweep and the absence escalations must leave members of EMS-managed
// projects alone; everyone else keeps the bot's existing behaviour.
const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
vi.mock("../src/core/logger.js", () => ({ logger }));
vi.mock("../src/config/loader.js", () => ({
  org: {
    timezone: "Asia/Kolkata",
    projects: [{ key: "alpha", name: "Alpha" }, { key: "beta", name: "Beta" }],
    attendancePolicy: { windowEnd: "17:30", minHours: 5, loginBy: "14:00", trackingStartsOn: undefined },
    enforcement: { mode: "strict", consecutiveShortDays: 2, ackHours: 24, strikeLimit: 3, startsOn: undefined },
  },
}));
const warnCreate = vi.fn(async ({ data }: { data: { userId: string } }) => ({ id: 1, ...data }));
// Rows returned for the "has an EMS-mirrored warn" lookup (where.source === "ems").
let emsWarnRows: { userId: string }[] = [];
const warnFindMany = vi.fn(async (args?: { where?: { source?: string } }) => (args?.where?.source === "ems" ? emsWarnRows : []));
const warnGroupBy = vi.fn(async () => [] as unknown[]);
const warnFindUnique = vi.fn(async () => null as unknown);
const warnUpdate = vi.fn(async () => ({}));
const memberFindMany = vi.fn(async () => [] as unknown[]);
vi.mock("../src/core/db.js", () => ({
  prisma: {
    warn: { create: warnCreate, findMany: warnFindMany, groupBy: warnGroupBy, findUnique: warnFindUnique, update: warnUpdate },
    warnNote: { create: vi.fn(async () => ({})) },
    member: { findMany: memberFindMany },
    termination: { findMany: vi.fn(async () => []) },
  },
}));
let client: unknown = null;
vi.mock("../src/core/botClient.js", () => ({ botClient: () => client, botGuild: () => null }));
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

const { runHoursSweep, dismissWarning, revokeWarning } = await import("../src/services/warnings.js");
const { runEscalations } = await import("../src/services/escalation.js");

beforeEach(() => {
  client = null;
  emsWarnRows = [];
  for (const f of [warnCreate, warnUpdate, warnFindUnique, warnGroupBy, memberFindMany, logger.warn, logger.error]) f.mockClear();
  warnGroupBy.mockResolvedValue([]);
  memberFindMany.mockResolvedValue([]);
  warnFindUnique.mockResolvedValue(null);
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

describe("strict-mode termination never removes an intern EMS has warned", () => {
  it("skips (and logs) a candidate with any source-ems warn, even when the project isn't on the switch", async () => {
    setting = '{"disabledProjects":[]}';
    client = {};
    warnGroupBy.mockResolvedValue([
      { userId: "u-ems", _count: { _all: 3 } },
      { userId: "u-bot", _count: { _all: 3 } },
    ]);
    memberFindMany.mockResolvedValue([
      { id: "u-ems", fullName: "E", displayName: null, tag: null, project: "Renamed Gamma", batch: null },
      { id: "u-bot", fullName: "B", displayName: null, tag: null, project: "Renamed Gamma", batch: null },
    ]);
    emsWarnRows = [{ userId: "u-ems" }];
    const out = await runHoursSweep("g1");
    // u-bot goes on to terminateMember (which fails here: no guild); u-ems never does.
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]![0]).toMatchObject({ userId: "u-bot" });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-ems" }), expect.stringMatching(/EMS/));
    expect(out.terminated).toBe(1);
  });
});

describe("EMS-mirrored warnings are managed in EMS only", () => {
  const ems = { id: 7, guildId: "g1", userId: "u1", source: "ems", status: "sent" };
  it("dashboard dismiss and revoke refuse a source-ems warn and change nothing", async () => {
    warnFindUnique.mockResolvedValue(ems);
    await expect(dismissWarning(7, "g1", "hr")).rejects.toThrow(/EMS/);
    await expect(revokeWarning(7, "g1", "hr", "mistake")).rejects.toThrow(/EMS/);
    expect(warnUpdate).not.toHaveBeenCalled();
  });
  it("a bot warn can still be dismissed", async () => {
    warnFindUnique.mockResolvedValue({ ...ems, source: "auto", status: "proposed" });
    await dismissWarning(7, "g1", "hr");
    expect(warnUpdate).toHaveBeenCalledWith({ where: { id: 7 }, data: { status: "dismissed", reviewedBy: "hr" } });
  });
});
