import { prisma } from "../core/db.js";
/**
 * Turn per-status counts (keys as stored: present, late, left_early, absent,
 * excused) into the numbers every view shows. left_early is attended-but-flagged:
 * it counts toward the attendance rate and is reported on its own.
 */
export function summarizeCounts(c) {
    const present = c.present ?? 0;
    const late = c.late ?? 0;
    const leftEarly = c.left_early ?? 0;
    const absent = c.absent ?? 0;
    const excused = c.excused ?? 0;
    const attended = present + late + leftEarly;
    const expected = attended + absent;
    return {
        present, late, leftEarly, absent, excused, expected, attended,
        pct: expected ? Math.round((attended / expected) * 1000) / 10 : 0,
    };
}
function whereFrom(f) {
    const where = {
        meeting: { guildId: f.guildId },
    };
    if (f.userId)
        where.userId = f.userId;
    if (f.batch)
        where.batch = f.batch;
    if (f.project)
        where.project = f.project;
    if (f.module !== undefined)
        where.module = f.module;
    if (f.pod !== undefined)
        where.pod = f.pod;
    if (f.meetingId !== undefined)
        where.meetingId = f.meetingId;
    if (f.from || f.to) {
        where.scheduledStart = {};
        if (f.from)
            where.scheduledStart.gte = f.from;
        if (f.to)
            where.scheduledStart.lte = f.to;
    }
    return where;
}
export async function computeAttendance(f) {
    const rows = await prisma.meetingAttendance.findMany({
        where: whereFrom(f),
        select: { meetingId: true, status: true, minutesLate: true },
    });
    let present = 0;
    let late = 0;
    let leftEarly = 0;
    let absent = 0;
    let excused = 0;
    let delaySum = 0;
    const meetings = new Set();
    for (const r of rows) {
        meetings.add(r.meetingId);
        switch (r.status) {
            case "present":
                present++;
                break;
            case "late":
                late++;
                delaySum += r.minutesLate;
                break;
            case "left_early":
                // Keeps minutesLate from the first join: an early leaver can also be late.
                leftEarly++;
                if (r.minutesLate > 0)
                    delaySum += r.minutesLate;
                break;
            case "absent":
                absent++;
                break;
            case "excused":
                excused++;
                break;
        }
    }
    const counted = present + late + leftEarly + absent;
    const attended = present + late + leftEarly;
    return {
        records: rows.length,
        totalMeetings: meetings.size,
        present,
        late,
        leftEarly,
        absent,
        excused,
        attendancePct: counted > 0 ? Math.round((attended / counted) * 1000) / 10 : 0,
        avgDelayMin: attended > 0 ? Math.round((delaySum / attended) * 10) / 10 : 0,
    };
}
/** Count a member's total unexcused absences (used for escalation). */
export function countAbsences(userId, guildId) {
    return prisma.meetingAttendance.count({
        where: { userId, status: "absent", meeting: { guildId } },
    });
}
/** Aggregate attendance per member within a filter. */
export async function computeByMember(f) {
    const rows = await prisma.meetingAttendance.findMany({
        where: whereFrom(f),
        select: {
            userId: true,
            fullName: true,
            project: true,
            module: true,
            pod: true,
            status: true,
        },
    });
    const map = new Map();
    for (const r of rows) {
        let s = map.get(r.userId);
        if (!s) {
            s = {
                userId: r.userId,
                fullName: r.fullName ?? r.userId,
                project: r.project ?? "?",
                module: r.module,
                pod: r.pod,
                present: 0,
                late: 0,
                leftEarly: 0,
                absent: 0,
                excused: 0,
                total: 0,
                pct: 0,
            };
            map.set(r.userId, s);
        }
        if (r.status === "present")
            s.present++;
        else if (r.status === "late")
            s.late++;
        else if (r.status === "left_early")
            s.leftEarly++;
        else if (r.status === "absent")
            s.absent++;
        else if (r.status === "excused")
            s.excused++;
    }
    for (const s of map.values()) {
        s.total = s.present + s.late + s.leftEarly + s.absent;
        s.pct = s.total > 0 ? Math.round(((s.present + s.late + s.leftEarly) / s.total) * 1000) / 10 : 0;
    }
    return Array.from(map.values());
}
/** Per-record rows joined with meeting info, for detailed CSV export. */
export async function computeRecords(f) {
    return prisma.meetingAttendance.findMany({
        where: whereFrom(f),
        select: {
            userId: true,
            fullName: true,
            batch: true,
            project: true,
            module: true,
            pod: true,
            status: true,
            minutesLate: true,
            actualJoinAt: true,
            scheduledStart: true,
            meeting: { select: { id: true, title: true } },
        },
        orderBy: { scheduledStart: "desc" },
        take: 5000,
    });
}
//# sourceMappingURL=attendanceStats.js.map