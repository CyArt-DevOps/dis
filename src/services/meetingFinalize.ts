import type { Meeting } from "@prisma/client";
import { prisma } from "../core/db.js";
import { logger } from "../core/logger.js";
import { hasApprovedLeaveCovering } from "./leave.js";
import { meetingWindow, secondsInWindow, statusAfterTimes } from "./meetingMath.js";

/**
 * End-of-meeting steps that run after the last attendance tick and the
 * voice-session backfill (Phase 3 §3.2):
 *   1. applyAttendanceTimes — secondsAttended per row; joined under 70 % → left_early.
 *   2. reexcuseApprovedLeave — approved leave wins over absent and left_early.
 */
export async function applyAttendanceTimes(meeting: Meeting, now = new Date()): Promise<number> {
  const rows = await prisma.meetingAttendance.findMany({
    where: { meetingId: meeting.id },
    select: { id: true, userId: true, status: true, secondsAttended: true },
  });
  if (rows.length === 0) return 0;
  const { start, end } = meetingWindow(meeting);
  const sessions = await prisma.voiceSession.findMany({
    where: {
      guildId: meeting.guildId,
      channelId: meeting.voiceChannelId,
      userId: { in: rows.map((r) => r.userId) },
      joinedAt: { lt: end },
      OR: [{ leftAt: null }, { leftAt: { gt: start } }],
    },
    select: { userId: true, joinedAt: true, leftAt: true },
  });
  const byUser = new Map<string, { joinedAt: Date; leftAt: Date | null }[]>();
  for (const s of sessions) {
    const list = byUser.get(s.userId) ?? [];
    list.push(s);
    byUser.set(s.userId, list);
  }
  let leftEarly = 0;
  for (const r of rows) {
    const seconds = secondsInWindow(byUser.get(r.userId) ?? [], start, end, now);
    const status = statusAfterTimes(r.status, seconds, meeting.durationMin);
    if (status === "left_early" && r.status !== "left_early") leftEarly++;
    if (seconds === r.secondsAttended && status === r.status) continue;
    await prisma.meetingAttendance.update({ where: { id: r.id }, data: { secondsAttended: seconds, status } });
  }
  if (leftEarly > 0) logger.info({ meeting: meeting.id, leftEarly }, "Marked early leavers");
  return leftEarly;
}

/**
 * Re-check approved leave for anyone still absent or left early. Leave approved
 * during (or right after) a meeting excuses the member instead of counting
 * against them and feeding escalation.
 */
export async function reexcuseApprovedLeave(meeting: Meeting): Promise<number> {
  const rows = await prisma.meetingAttendance.findMany({
    where: { meetingId: meeting.id, status: { in: ["absent", "left_early"] } },
    select: { id: true, userId: true },
  });
  let excused = 0;
  for (const row of rows) {
    if (!(await hasApprovedLeaveCovering(meeting.guildId, row.userId, meeting.startAt))) continue;
    await prisma.meetingAttendance.update({
      where: { id: row.id },
      data: { status: "excused", leaveStatus: "approved" },
    });
    excused++;
  }
  return excused;
}
