import type { Meeting, MeetingAttendance } from "@prisma/client";
import { prisma } from "../core/db.js";
import { enqueueEvent } from "./emsOutbox.js";

/**
 * Wire shapes and outbox events for meetings synced with EMS (Phase 3 §3.3–3.4).
 * EMS's services/meetingSync.js consumes these.
 */
export interface MeetingDto {
  uid: string;
  title: string;
  description: string | null;
  organizerDiscordId: string;
  startAt: string;
  durationMin: number;
  audienceType: string;
  audienceBatch: string | null;
  audienceProject: string | null;
  audienceModule: number | null;
  audiencePod: number | null;
  audienceMemberIds: string[] | null;
  mandatory: boolean;
  status: string;
  source: string;
  recurrenceUid: string | null;
  voiceChannelId: string;
  createdAt: string;
  updatedAt: string;
}

export interface AttendanceRowDto {
  discordUserId: string;
  status: string;
  minutesLate: number;
  secondsAttended: number;
}

export function meetingDto(m: Meeting): MeetingDto {
  return {
    uid: m.uid,
    title: m.title,
    description: m.description,
    organizerDiscordId: m.organizerId,
    startAt: m.startAt.toISOString(),
    durationMin: m.durationMin,
    audienceType: m.audienceType,
    audienceBatch: m.audienceBatch,
    audienceProject: m.audienceProject,
    audienceModule: m.audienceModule,
    audiencePod: m.audiencePod,
    audienceMemberIds: m.audienceMemberIds ? m.audienceMemberIds.split(",").filter(Boolean) : null,
    mandatory: m.mandatory,
    status: m.status,
    source: m.source,
    recurrenceUid: m.recurrenceUid,
    voiceChannelId: m.voiceChannelId,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

export function attendanceRows(rows: Pick<MeetingAttendance, "userId" | "status" | "minutesLate" | "secondsAttended">[]): AttendanceRowDto[] {
  return rows.map((r) => ({
    discordUserId: r.userId,
    status: r.status,
    minutesLate: r.minutesLate,
    secondsAttended: r.secondsAttended,
  }));
}

export type MeetingEventType = "meeting.created" | "meeting.updated" | "meeting.cancelled";

/** Queue a meeting change for EMS. Never throws (enqueueEvent swallows its own errors). */
export async function emitMeetingEvent(type: MeetingEventType, m: Meeting): Promise<void> {
  await enqueueEvent(type, meetingDto(m));
}

/**
 * Queue the final attendance of a completed meeting. Called once after the
 * end-of-meeting pass, and again whenever a later leave decision changes a row.
 */
export async function emitAttendance(meetingId: number): Promise<void> {
  const m = await prisma.meeting.findUnique({ where: { id: meetingId } });
  if (!m || m.status !== "completed") return;
  const rows = await prisma.meetingAttendance.findMany({
    where: { meetingId },
    select: { userId: true, status: true, minutesLate: true, secondsAttended: true },
    orderBy: { userId: "asc" },
  });
  await enqueueEvent("meeting.attendance", { uid: m.uid, generatedAt: new Date().toISOString(), rows: attendanceRows(rows) });
}
