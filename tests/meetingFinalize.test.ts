import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/core/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
const covered = new Set<string>();
vi.mock("../src/services/leave.js", () => ({
  hasApprovedLeaveCovering: vi.fn(async (_g: string, userId: string) => covered.has(userId)),
}));

type Row = { id: number; userId: string; status: string; secondsAttended: number };
let rows: Row[] = [];
let sessions: { userId: string; joinedAt: Date; leftAt: Date | null }[] = [];
const update = vi.fn(async ({ where, data }: { where: { id: number }; data: Partial<Row> }) => {
  Object.assign(rows.find((r) => r.id === where.id)!, data);
});
vi.mock("../src/core/db.js", () => ({
  prisma: {
    meetingAttendance: {
      findMany: vi.fn(async ({ where }: { where: { status?: { in: string[] } } }) =>
        rows.filter((r) => !where.status || where.status.in.includes(r.status)).map((r) => ({ ...r }))),
      update,
    },
    voiceSession: { findMany: vi.fn(async () => sessions) },
  },
}));

const { applyAttendanceTimes, reexcuseApprovedLeave, downtimeOverlaps } = await import("../src/services/meetingFinalize.js");

const t = (hhmm: string) => new Date(`2026-10-27T${hhmm}:00Z`);
// 60-minute meeting 10:00–11:00 (the 10-minute attendance window is not meeting time).
const meeting = { id: 1, guildId: "g1", voiceChannelId: "v1", startAt: t("10:00"), durationMin: 60 } as never;
// The bot has been up since before the meeting (no downtime overlap).
const booted = t("08:00");

beforeEach(() => {
  covered.clear();
  update.mockClear();
  rows = [
    { id: 1, userId: "stay", status: "present", secondsAttended: 0 },
    { id: 2, userId: "early", status: "late", secondsAttended: 0 },
    { id: 3, userId: "gone", status: "absent", secondsAttended: 0 },
    { id: 4, userId: "leave", status: "excused", secondsAttended: 0 },
  ];
  sessions = [
    { userId: "stay", joinedAt: t("09:50"), leftAt: t("11:20") }, // clipped to 60 min
    { userId: "early", joinedAt: t("10:05"), leftAt: t("10:30") }, // 25 of 60 min
  ];
});

describe("applyAttendanceTimes", () => {
  it("stores clipped secondsAttended and marks joined members under 70 % left_early", async () => {
    expect(await applyAttendanceTimes(meeting, t("12:00"), booted)).toBe(1);
    expect(rows.map((r) => [r.userId, r.status, r.secondsAttended])).toEqual([
      ["stay", "present", 3600],
      ["early", "left_early", 1500],
      ["gone", "absent", 0],
      ["leave", "excused", 0],
    ]);
  });
  it("bot downtime overlapping the meeting: seconds are stored but nobody is marked left_early", async () => {
    expect(await applyAttendanceTimes(meeting, t("12:00"), t("10:20"))).toBe(0);
    expect(rows.find((r) => r.userId === "early")).toMatchObject({ status: "late", secondsAttended: 1500 });
    expect(downtimeOverlaps(meeting, t("10:20"))).toBe(true);
    expect(downtimeOverlaps(meeting, t("09:59"))).toBe(false);
  });
  it("writes nothing when the numbers are unchanged", async () => {
    await applyAttendanceTimes(meeting, t("12:00"), booted);
    update.mockClear();
    await applyAttendanceTimes(meeting, t("12:00"), booted);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("reexcuseApprovedLeave", () => {
  it("approved leave beats left_early and absent", async () => {
    await applyAttendanceTimes(meeting, t("12:00"), booted);
    covered.add("early").add("gone");
    expect(await reexcuseApprovedLeave(meeting)).toBe(2);
    expect(rows.find((r) => r.userId === "early")!.status).toBe("excused");
    expect(rows.find((r) => r.userId === "gone")!.status).toBe("excused");
    expect(rows.find((r) => r.userId === "stay")!.status).toBe("present");
  });
});
