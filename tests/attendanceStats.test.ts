import { describe, it, expect, vi, beforeEach } from "vitest";

// left_early (joined, under 70 % of the meeting) is attended-but-flagged: it counts
// toward the attendance rate and is reported on its own (Phase 3 §3.2).
type Row = { meetingId: number; userId: string; fullName: string; project: string; module: number; pod: number; status: string; minutesLate: number };
let rows: Row[] = [];
vi.mock("../src/core/db.js", () => ({
  prisma: { meetingAttendance: { findMany: vi.fn(async () => rows) } },
}));

const { computeAttendance, computeByMember, summarizeCounts } = await import("../src/services/attendanceStats.js");

const r = (userId: string, status: string, minutesLate = 0, meetingId = 1): Row => ({
  meetingId, userId, fullName: userId, project: "Alpha", module: 1, pod: 1, status, minutesLate,
});

beforeEach(() => {
  rows = [r("a", "present"), r("b", "late", 10), r("c", "left_early", 20), r("d", "left_early"), r("e", "absent"), r("f", "excused")];
});

describe("left_early in the bot's own stats", () => {
  it("computeAttendance counts left_early as attended and keeps its minutes late", async () => {
    const s = await computeAttendance({ guildId: "g1" });
    expect(s).toMatchObject({ present: 1, late: 1, leftEarly: 2, absent: 1, excused: 1 });
    expect(s.attendancePct).toBe(80); // 4 attended of 5 expected (excused left out)
    expect(s.avgDelayMin).toBe(7.5); // (10 + 20) / 4 attended
  });
  it("computeByMember has a leftEarly counter inside total and pct", async () => {
    rows = [r("a", "left_early", 0, 1), r("a", "absent", 0, 2), r("a", "present", 0, 3)];
    const [m] = await computeByMember({ guildId: "g1" });
    expect(m).toMatchObject({ leftEarly: 1, absent: 1, present: 1, total: 3, pct: 66.7 });
  });
  it("summarizeCounts maps stored status keys for per-meeting views", () => {
    expect(summarizeCounts({ present: 2, late: 1, left_early: 1, absent: 1, excused: 3 })).toEqual({
      present: 2, late: 1, leftEarly: 1, absent: 1, excused: 3, attended: 4, expected: 5, pct: 80,
    });
    expect(summarizeCounts({}).pct).toBe(0);
  });
});
