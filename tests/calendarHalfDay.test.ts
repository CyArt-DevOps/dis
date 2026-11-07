import { describe, it, expect, vi } from "vitest";

// HG-DIS-01: a member on approved half-day leave is NOT off for the day; only the window is skipped.
// Policy: join by 14:00, 5.5 h. On a half day the target drops by 3 h (2.5 h) and, when the window
// starts at or before 14:00, the join cutoff moves to the window end (same rule as the EMS close).
vi.mock("../src/config/loader.js", () => ({
  org: {
    timezone: "Asia/Kolkata",
    attendancePolicy: { loginBy: "14:00", minHours: 5.5, workdays: [1, 2, 3, 4, 5], trackingStartsOn: "2026-06-01" },
  },
  activeProjects: () => [],
}));
vi.mock("../src/services/holidays.js", () => ({ holidayMap: vi.fn(async () => new Map()) }));

const DAY = "2026-11-02"; // a Monday, already settled
const ist = (hhmm: string) => new Date(`${DAY}T${hhmm}:00+05:30`);
const members = ["a", "b", "c", "d", "e"].map((id) => ({
  id, fullName: id, displayName: id, tag: id, batch: null, project: null, module: null, pod: null, joinedAt: new Date("2026-10-01T00:00:00Z"),
}));
const H = 3600;
const attendance = [
  { userId: "a", day: DAY, seconds: 2.5 * H },
  { userId: "c", day: DAY, seconds: 2.5 * H },
  { userId: "d", day: DAY, seconds: 2 * H },
  { userId: "e", day: DAY, seconds: 2.5 * H },
];
const sessions = [
  { userId: "a", joinedAt: ist("16:00"), leftAt: ist("18:30"), creditedUpTo: null },
  { userId: "c", joinedAt: ist("14:20"), leftAt: ist("16:50"), creditedUpTo: null },
  { userId: "d", joinedAt: ist("16:00"), leftAt: ist("18:00"), creditedUpTo: null },
  { userId: "e", joinedAt: ist("16:00"), leftAt: ist("18:30"), creditedUpTo: null },
];
const half = (userId: string, start: string, end: string) => ({
  userId, startAt: ist(start), endAt: ist(end), approvedDays: DAY, halfDay: true, halfStart: start, halfEnd: end,
});
const leaves = [
  half("a", "13:00", "16:00"),
  { userId: "b", startAt: new Date(`${DAY}T00:00:00+05:30`), endAt: new Date(`${DAY}T23:59:59+05:30`), approvedDays: DAY, halfDay: false, halfStart: null, halfEnd: null },
  half("c", "11:30", "14:30"),
  half("d", "13:00", "16:00"),
];
vi.mock("../src/core/db.js", () => ({
  prisma: {
    member: { findMany: vi.fn(async () => members) },
    attendance: { findMany: vi.fn(async () => attendance), groupBy: vi.fn(async () => []) },
    voiceSession: { findMany: vi.fn(async () => sessions) },
    leaveRequest: { findMany: vi.fn(async () => leaves) },
  },
}));

const { buildCalendars } = await import("../src/services/calendar.js");

describe("half-day leave in the attendance calendar", () => {
  it("keeps the day a working day with a 2.5 h target and the cutoff at the window end", async () => {
    const cals = await buildCalendars("g1", {}, DAY, DAY);
    const day = (id: string) => cals.find((c) => c.userId === id)!.days[0]!;
    // a: off 13:00–16:00, joined 16:00 with 2.5 h → good, not leave
    expect(day("a")).toMatchObject({ status: "good", onTime: true, halfDay: { start: "13:00", end: "16:00" }, requiredSeconds: 2.5 * H, loginBy: "16:00" });
    // b: full day → leave
    expect(day("b").status).toBe("leave");
    expect(day("b").halfDay).toBeUndefined();
    // c: off 11:30–14:30, joined 14:20 (before the moved cutoff) → good
    expect(day("c")).toMatchObject({ status: "good", onTime: true });
    // d: half day but only 2 h → partial (counts against them; the day is not excused)
    expect(day("d")).toMatchObject({ status: "partial", onTime: true });
    // e: no leave, joined 16:00 with 2.5 h → partial (late and short)
    expect(day("e")).toMatchObject({ status: "partial", onTime: false });
    expect(day("e").requiredSeconds).toBeUndefined();
    const a = cals.find((c) => c.userId === "a")!;
    expect(a.totals).toMatchObject({ good: 1, leave: 0 });
  });
});
