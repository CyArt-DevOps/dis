import { prisma } from "../core/db.js";
import { org } from "../config/loader.js";
import { shiftDayKey, tzDateKey, tzDayStartUtc } from "../lib/time.js";
import { hasApprovedLeaveCovering } from "./leave.js";
import { clearCalendarCache } from "./calendar.js";
import { clearInsightsCache } from "./insights.js";
import { joinedStatus, meetingWindow, secondsInWindow } from "./meetingMath.js";
import { emitAttendance } from "./meetingSync.js";
import { halfWindowError, halfWindowUtc, leaveCoversAt, toHhmm, toMinutes } from "../lib/halfDay.js";

/**
 * Leave granted by HR straight from the dashboard profile, for specific days.
 *
 * Stored like an HR-approved exam leave: an approved LeaveRequest whose
 * `approvedDays` lists the exact days. Everything downstream (calendar,
 * compliance, meeting excusal, escalation) already honours that shape, so a
 * dashboard grant behaves exactly like one approved in a Discord ticket.
 * `reviewedById` carries a "dashboard:" prefix so these rows are recognisable.
 * The dashboard can revoke any approved leave, including one approved in Discord.
 */

export const DASHBOARD_REVIEWER = "dashboard:";
/** Prefix on the approver's name for leave granted from EMS (HR actions sync). */
export const EMS_APPROVER = "EMS: ";

/** Where an approved leave was decided: EMS may withdraw its own and dashboard grants, not Discord approvals. */
export function leaveOrigin(reviewedById: string | null): "discord" | "dashboard" | "ems" {
  if (reviewedById?.startsWith(`${DASHBOARD_REVIEWER}${EMS_APPROVER}`)) return "ems";
  return reviewedById?.startsWith(DASHBOARD_REVIEWER) ? "dashboard" : "discord";
}

/** The IST days a leave covers: its exact approved days, else every day of its range. */
export function leaveDays(row: { approvedDays: string | null; startAt: Date; endAt: Date }): string[] {
  const exact = (row.approvedDays ?? "").split(",").filter(Boolean);
  if (exact.length) return exact;
  const days: string[] = [];
  const last = tzDateKey(row.endAt);
  for (let d = tzDateKey(row.startAt); d <= last; d = shiftDayKey(d, 1)) days.push(d);
  return days;
}
const TYPES = ["casual", "sick", "exam"] as const;
export type ManualLeaveType = (typeof TYPES)[number];

export interface ManualLeaveInput {
  dates: string[];
  type: string;
  reason: string;
  approvedBy: string;
  /** Half-day leave: the 3 h window ("HH:MM" IST) on the single date. */
  half?: { start: string; end: string };
}

export class LeaveInputError extends Error {}

function validate(input: ManualLeaveInput): {
  days: string[]; type: ManualLeaveType; reason: string; by: string; half: { start: string; end: string } | null;
} {
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
  let half: { start: string; end: string } | null = null;
  if (input.half) {
    if (days.length !== 1) throw new LeaveInputError("A half day is a single date.");
    const bad = halfWindowError(input.half.start, input.half.end);
    if (bad) throw new LeaveInputError(bad);
    // Stored as "HH:MM" (VARCHAR(5)): "13:00:00" or " 13:00" would not fit / would not match.
    half = { start: toHhmm(toMinutes(input.half.start)!), end: toHhmm(toMinutes(input.half.end)!) };
  }
  return { days, type, reason, by, half };
}

/** Meeting rows for this member on these local days. */
async function meetingRowsOn(guildId: string, userId: string, days: string[]) {
  const start = tzDayStartUtc(days[0]!);
  const end = tzDayStartUtc(shiftDayKey(days[days.length - 1]!, 1));
  const rows = await prisma.meetingAttendance.findMany({
    where: { userId, scheduledStart: { gte: start, lt: end }, meeting: { guildId } },
    select: {
      id: true, meetingId: true, status: true, scheduledStart: true, actualJoinAt: true, leaveStatus: true,
      minutesLate: true, secondsAttended: true,
      meeting: { select: { durationMin: true, startAt: true, guildId: true, voiceChannelId: true, status: true } },
    },
  });
  const set = new Set(days);
  return rows.filter((r) => set.has(tzDateKey(r.scheduledStart)));
}

type MeetingRow = Awaited<ReturnType<typeof meetingRowsOn>>[number];

/**
 * Status (and seconds) to restore on a joined row whose leave was revoked.
 * Rows from before Phase 3 (or excused before the end pass) carry
 * secondsAttended = 0: their time is computed from the voice sessions, as the
 * end-of-meeting pass does. With no sessions on record there is nothing to
 * judge by, so the row goes back to present / late — never left_early on 0.
 * A meeting that is not completed yet also goes back to present / late: its end
 * pass decides left_early.
 */
async function restoredJoined(userId: string, r: MeetingRow): Promise<{ status: string; secondsAttended: number }> {
  if (r.meeting.status !== "completed") {
    return { status: r.minutesLate > 0 ? "late" : "present", secondsAttended: r.secondsAttended };
  }
  let seconds = r.secondsAttended;
  if (seconds === 0) {
    const { start, end } = meetingWindow(r.meeting);
    const sessions = await prisma.voiceSession.findMany({
      where: {
        guildId: r.meeting.guildId,
        channelId: r.meeting.voiceChannelId,
        userId,
        joinedAt: { lt: end },
        OR: [{ leftAt: null }, { leftAt: { gt: start } }],
      },
      select: { joinedAt: true, leftAt: true },
    });
    // The meeting is over: an open session counts up to the meeting's end.
    seconds = secondsInWindow(sessions, start, end, end);
    if (seconds === 0) return { status: r.minutesLate > 0 ? "late" : "present", secondsAttended: 0 };
  }
  return { status: joinedStatus(r.minutesLate, seconds, r.meeting.durationMin), secondsAttended: seconds };
}

/** A leave decision changed rows of finished meetings: send EMS their attendance again (Phase 3 §3.4). */
async function resendAttendance(meetingIds: Set<number>): Promise<void> {
  for (const id of meetingIds) await emitAttendance(id).catch(() => {});
}

export async function grantManualLeave(
  guildId: string,
  userId: string,
  input: ManualLeaveInput,
  opts: { uid?: string } = {}
): Promise<{ id: number; days: string[]; excusedMeetings: number }> {
  const v = validate(input);
  const member = await prisma.member.findUnique({ where: { id: userId }, select: { guildId: true } });
  if (!member || member.guildId !== guildId) throw new LeaveInputError("Member not found.");

  // A half day spans just its window; a full grant spans whole days.
  const window = v.half ? halfWindowUtc(v.days[0]!, v.half.start, v.half.end) : null;
  const cover = {
    startAt: window ? window.start : tzDayStartUtc(v.days[0]!),
    endAt: window ? window.end : new Date(tzDayStartUtc(shiftDayKey(v.days[v.days.length - 1]!, 1)).getTime() - 1000),
    approvedDays: v.days.join(","),
    ...(v.half ? { halfDay: true, halfStart: v.half.start, halfEnd: v.half.end } : {}),
  };
  const row = await prisma.leaveRequest.create({
    data: {
      ...(opts.uid ? { uid: opts.uid } : {}),
      guildId,
      userId,
      type: v.type,
      ...cover,
      reason: v.reason,
      status: "approved",
      reviewedById: `${DASHBOARD_REVIEWER}${v.by}`,
      reviewedAt: new Date(),
    },
  });

  // Meetings already held on those days: an absence (or an early leave) becomes
  // excused, as it would have if the leave had existed when the meeting started.
  // A half day excuses only meetings that start inside its window.
  let excusedMeetings = 0;
  const changed = new Set<number>();
  for (const r of await meetingRowsOn(guildId, userId, v.days)) {
    if (r.status !== "absent" && r.status !== "left_early") continue;
    if (!leaveCoversAt(cover, r.scheduledStart)) continue;
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

/** Undo an approved leave, wherever it was approved. */
export async function revokeManualLeave(guildId: string, userId: string, leaveId: number): Promise<void> {
  const row = await prisma.leaveRequest.findUnique({ where: { id: leaveId } });
  if (!row || row.guildId !== guildId || row.userId !== userId) throw new LeaveInputError("Leave not found.");
  if (row.status !== "approved") throw new LeaveInputError("This leave is not active.");
  await prisma.leaveRequest.update({ where: { id: leaveId }, data: { status: "revoked" } });

  // Put back what this grant excused, unless another approved leave still covers
  // the meeting: no join → absent; joined → present / late / left_early again.
  const days = leaveDays(row);
  const changed = new Set<number>();
  if (days.length) {
    for (const r of await meetingRowsOn(guildId, userId, days)) {
      if (r.status !== "excused") continue;
      if (await hasApprovedLeaveCovering(guildId, userId, r.scheduledStart)) continue;
      const restored = r.actualJoinAt ? await restoredJoined(userId, r) : { status: "absent", secondsAttended: r.secondsAttended };
      await prisma.meetingAttendance.update({
        where: { id: r.id },
        data: { status: restored.status, secondsAttended: restored.secondsAttended, leaveStatus: "none" },
      });
      changed.add(r.meetingId);
    }
  }
  await resendAttendance(changed);
  clearCalendarCache();
  clearInsightsCache();
}
