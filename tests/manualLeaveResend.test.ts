import { describe, it, expect, vi, beforeEach } from "vitest";

// A dashboard leave grant / revoke that changes rows of a finished meeting re-sends
// that meeting's attendance to EMS (Phase 3 §3.4).
vi.mock("../src/config/loader.js", () => ({ org: { timezone: "Asia/Kolkata", attendancePolicy: { trackingStartsOn: "2026-01-01" } } }));
vi.mock("../src/services/calendar.js", () => ({ clearCalendarCache: vi.fn() }));
vi.mock("../src/services/insights.js", () => ({ clearInsightsCache: vi.fn() }));
const covering = vi.fn(async () => false);
vi.mock("../src/services/leave.js", () => ({ hasApprovedLeaveCovering: covering }));
const emitAttendance = vi.fn(async () => {});
vi.mock("../src/services/meetingSync.js", () => ({ emitAttendance }));

type Row = {
  id: number; meetingId: number; status: string; scheduledStart: Date; actualJoinAt: Date | null;
  leaveStatus: string; minutesLate: number; secondsAttended: number; meeting: { durationMin: number };
};
let rows: Row[] = [];
const attUpdate = vi.fn(async ({ where, data }: { where: { id: number }; data: Partial<Row> }) => {
  Object.assign(rows.find((r) => r.id === where.id)!, data);
});
const leave = { id: 9, guildId: "g1", userId: "u1", status: "approved", reviewedById: "dashboard:Asha", approvedDays: "2026-10-27" };
vi.mock("../src/core/db.js", () => ({
  prisma: {
    member: { findUnique: vi.fn(async () => ({ guildId: "g1" })) },
    leaveRequest: { create: vi.fn(async () => ({ id: 9 })), findUnique: vi.fn(async () => leave), update: vi.fn(async () => ({})) },
    meetingAttendance: { findMany: vi.fn(async () => rows.map((r) => ({ ...r }))), update: attUpdate },
  },
}));

const { grantManualLeave, revokeManualLeave } = await import("../src/services/manualLeave.js");

// 2026-10-27 10:00 IST
const start = new Date("2026-10-27T04:30:00Z");
beforeEach(() => {
  emitAttendance.mockClear();
  rows = [
    { id: 1, meetingId: 5, status: "absent", scheduledStart: start, actualJoinAt: null, leaveStatus: "none", minutesLate: 0, secondsAttended: 0, meeting: { durationMin: 60 } },
    { id: 2, meetingId: 6, status: "left_early", scheduledStart: start, actualJoinAt: start, leaveStatus: "none", minutesLate: 12, secondsAttended: 900, meeting: { durationMin: 60 } },
    { id: 3, meetingId: 7, status: "present", scheduledStart: start, actualJoinAt: start, leaveStatus: "none", minutesLate: 0, secondsAttended: 3600, meeting: { durationMin: 60 } },
  ];
});

describe("dashboard leave and meeting attendance", () => {
  it("grant excuses absent and left_early rows and re-sends those meetings only", async () => {
    const out = await grantManualLeave("g1", "u1", { dates: ["2026-10-27"], type: "sick", reason: "fever", approvedBy: "Asha" });
    expect(out.excusedMeetings).toBe(2);
    expect(rows.map((r) => r.status)).toEqual(["excused", "excused", "present"]);
    expect(emitAttendance.mock.calls.map((c) => c[0]).sort()).toEqual([5, 6]);
  });
  it("revoke puts back absent / left_early from the stored numbers and re-sends", async () => {
    rows[0]!.status = "excused";
    rows[1]!.status = "excused";
    await revokeManualLeave("g1", "u1", 9);
    expect(rows.map((r) => r.status)).toEqual(["absent", "left_early", "present"]);
    expect(emitAttendance.mock.calls.map((c) => c[0]).sort()).toEqual([5, 6]);
  });
});
