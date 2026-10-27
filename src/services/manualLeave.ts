import { prisma } from "../core/db.js";
import { org } from "../config/loader.js";
import { shiftDayKey, tzDateKey, tzDayStartUtc } from "../lib/time.js";
import { hasApprovedLeaveCovering } from "./leave.js";
import { clearCalendarCache } from "./calendar.js";
import { clearInsightsCache } from "./insights.js";
import { joinedStatus } from "./meetingMath.js";
import { emitAttendance } from "./meetingSync.js";

/**
 * Leave granted by HR straight from the dashboard profile, for specific days.
 *
 * Stored like an HR-approved exam leave: an approved LeaveRequest whose
 * `approvedDays` lists the exact days. Everything downstream (calendar,
 * compliance, meeting excusal, escalation) already honours that shape, so a
 * dashboard grant behaves exactly like one approved in a Discord ticket.
 * `reviewedById` carries a "dashboard:" prefix so these rows are recognisable
 * and only they can be revoked from the dashboard.
 */

export const DASHBOARD_REVIEWER = "dashboard:";
const TYPES = ["casual", "sick", "exam"] as const;
export type ManualLeaveType = (typeof TYPES)[number];

export interface ManualLeaveInput {
  dates: string[];
  type: string;
  reason: string;
  approvedBy: string;
}

export class LeaveInputError extends Error {}

function validate(input: ManualLeaveInput): { days: string[]; type: ManualLeaveType; reason: string; by: string } {
  const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + "T00:00:00Z"));
  const raw = Array.isArray(input.dates) ? input.dates.map(String) : [];
  if (raw.length === 0) throw new LeaveInputError("Pick at least one date.");
  const bad = raw.find((d) => !isDay(d));
  if (bad) throw new LeaveInputError(`Invalid date: ${bad.slice(0, 20)}`);
  const days = [...new Set(raw)].sort();
  if (days.length > 31) throw new LeaveInputError("At most 31 days per grant.");
  const floor = org.attendancePolicy.trackingStartsOn ?? "2026-01-01";
  const ceiling = shiftDayKey(tzDateKey(new Date()), 120);
  if (days[0]! < floor) throw new LeaveInputError(`Dates before ${floor} are outside tracking.`);
  if (days[days.length - 1]! > ceiling) throw new LeaveInputError("Dates more than 120 days ahead are not allowed.");
  const type = TYPES.find((t) => t === input.type);
  if (!type) throw new LeaveInputError("Type must be casual, sick or exam.");
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 3 || reason.length > 500) throw new LeaveInputError("Reason must be 3–500 characters.");
  const by = String(input.approvedBy ?? "").trim();
  if (by.length < 2 || by.length > 60) throw new LeaveInputError("Enter the approving HR member's name.");
  return { days, type, reason, by };
}

/** Meeting rows for this member on these local days. */
async function meetingRowsOn(guildId: string, userId: string, days: string[]) {
  const start = tzDayStartUtc(days[0]!);
  const end = tzDayStartUtc(shiftDayKey(days[days.length - 1]!, 1));
  const rows = await prisma.meetingAttendance.findMany({
    where: { userId, scheduledStart: { gte: start, lt: end }, meeting: { guildId } },
    select: {
      id: true, meetingId: true, status: true, scheduledStart: true, actualJoinAt: true, leaveStatus: true,
      minutesLate: true, secondsAttended: true, meeting: { select: { durationMin: true } },
    },
  });
  const set = new Set(days);
  return rows.filter((r) => set.has(tzDateKey(r.scheduledStart)));
}

/** A leave decision changed rows of finished meetings: send EMS their attendance again (Phase 3 §3.4). */
async function resendAttendance(meetingIds: Set<number>): Promise<void> {
  for (const id of meetingIds) await emitAttendance(id).catch(() => {});
}

export async function grantManualLeave(
  guildId: string,
  userId: string,
  input: ManualLeaveInput
): Promise<{ id: number; days: string[]; excusedMeetings: number }> {
  const v = validate(input);
  const member = await prisma.member.findUnique({ where: { id: userId }, select: { guildId: true } });
  if (!member || member.guildId !== guildId) throw new LeaveInputError("Member not found.");

  const row = await prisma.leaveRequest.create({
    data: {
      guildId,
      userId,
      type: v.type,
      startAt: tzDayStartUtc(v.days[0]!),
      endAt: new Date(tzDayStartUtc(shiftDayKey(v.days[v.days.length - 1]!, 1)).getTime() - 1000),
      reason: v.reason,
      approvedDays: v.days.join(","),
      status: "approved",
      reviewedById: `${DASHBOARD_REVIEWER}${v.by}`,
      reviewedAt: new Date(),
    },
  });

  // Meetings already held on those days: an absence (or an early leave) becomes
  // excused, as it would have if the leave had existed when the meeting started.
  let excusedMeetings = 0;
  const changed = new Set<number>();
  for (const r of await meetingRowsOn(guildId, userId, v.days)) {
    if (r.status !== "absent" && r.status !== "left_early") continue;
    await prisma.meetingAttendance.update({
      where: { id: r.id },
      data: { status: "excused", leaveStatus: "approved" },
    });
    excusedMeetings++;
    changed.add(r.meetingId);
  }
  await resendAttendance(changed);

  clearCalendarCache();
  clearInsightsCache();
  return { id: row.id, days: v.days, excusedMeetings };
}

/** Undo a dashboard grant. Leaves approved in Discord are not touched here. */
export async function revokeManualLeave(guildId: string, userId: string, leaveId: number): Promise<void> {
  const row = await prisma.leaveRequest.findUnique({ where: { id: leaveId } });
  if (!row || row.guildId !== guildId || row.userId !== userId) throw new LeaveInputError("Leave not found.");
  if (!row.reviewedById?.startsWith(DASHBOARD_REVIEWER)) {
    throw new LeaveInputError("Only leave granted from the dashboard can be revoked here.");
  }
  if (row.status !== "approved") throw new LeaveInputError("This leave is not active.");
  await prisma.leaveRequest.update({ where: { id: leaveId }, data: { status: "revoked" } });

  // Put back what this grant excused, unless another approved leave still covers
  // the meeting: no join → absent; joined → present / late / left_early again.
  const days = (row.approvedDays ?? "").split(",").filter(Boolean);
  const changed = new Set<number>();
  if (days.length) {
    for (const r of await meetingRowsOn(guildId, userId, days)) {
      if (r.status !== "excused") continue;
      if (await hasApprovedLeaveCovering(guildId, userId, r.scheduledStart)) continue;
      const status = r.actualJoinAt ? joinedStatus(r.minutesLate, r.secondsAttended, r.meeting.durationMin) : "absent";
      await prisma.meetingAttendance.update({
        where: { id: r.id },
        data: { status, leaveStatus: "none" },
      });
      changed.add(r.meetingId);
    }
  }
  await resendAttendance(changed);
  clearCalendarCache();
  clearInsightsCache();
}
