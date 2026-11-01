import { prisma } from "../core/db.js";
import { enqueueEvent } from "./emsOutbox.js";
export function meetingDto(m) {
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
export function attendanceRows(rows) {
    return rows.map((r) => ({
        discordUserId: r.userId,
        status: r.status,
        minutesLate: r.minutesLate,
        secondsAttended: r.secondsAttended,
    }));
}
/** Queue a meeting change for EMS. Never throws (enqueueEvent swallows its own errors). */
export async function emitMeetingEvent(type, m) {
    await enqueueEvent(type, meetingDto(m));
}
/**
 * Queue the final attendance of a completed meeting. Called once after the
 * end-of-meeting pass, and again whenever a later leave decision changes a row.
 */
export async function emitAttendance(meetingId) {
    const m = await prisma.meeting.findUnique({ where: { id: meetingId } });
    if (!m || m.status !== "completed")
        return;
    const rows = await prisma.meetingAttendance.findMany({
        where: { meetingId },
        select: { userId: true, status: true, minutesLate: true, secondsAttended: true },
        orderBy: { userId: "asc" },
    });
    await enqueueEvent("meeting.attendance", { uid: m.uid, generatedAt: new Date().toISOString(), rows: attendanceRows(rows) });
}
//# sourceMappingURL=meetingSync.js.map