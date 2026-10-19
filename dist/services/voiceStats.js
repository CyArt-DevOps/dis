import { prisma } from "../core/db.js";
import { holidayMap } from "./holidays.js";
import { org } from "../config/loader.js";
import { shiftDayKey, splitByTzDay, tzDateKey, tzDayStartUtc } from "../lib/time.js";
export function defaultRange(guildId, days = 7) {
    const to = tzDateKey(new Date());
    return { guildId, from: shiftDayKey(to, -(days - 1)), to };
}
/** Uncredited seconds from still-open sessions, per user per day. */
export async function pendingByUser(guildId, userId) {
    const open = await prisma.voiceSession.findMany({
        where: { guildId, leftAt: null, ...(userId ? { userId } : {}) },
    });
    const now = new Date();
    const out = new Map();
    for (const s of open) {
        const from = s.creditedUpTo ?? s.joinedAt;
        if (now.getTime() <= from.getTime())
            continue;
        const perDay = out.get(s.userId) ?? new Map();
        for (const b of splitByTzDay(from, now))
            perDay.set(b.day, (perDay.get(b.day) ?? 0) + b.seconds);
        out.set(s.userId, perDay);
    }
    return out;
}
/** Per-member voice totals over a day range, live sessions included. */
export async function voiceByMember(range) {
    const { guildId, from, to } = range;
    const [rows, pending, members] = await Promise.all([
        prisma.attendance.findMany({
            where: { guildId, day: { gte: from, lte: to } },
            select: { userId: true, day: true, seconds: true },
        }),
        pendingByUser(guildId),
        prisma.member.findMany({
            where: { guildId, status: { not: "former" } },
            select: {
                id: true,
                fullName: true,
                tag: true,
                batch: true,
                project: true,
                module: true,
                pod: true,
            },
        }),
    ]);
    const totals = new Map();
    const bump = (userId, day, seconds) => {
        if (seconds <= 0)
            return;
        const t = totals.get(userId) ?? { seconds: 0, days: new Set() };
        t.seconds += seconds;
        t.days.add(day);
        totals.set(userId, t);
    };
    for (const r of rows)
        bump(r.userId, r.day, r.seconds);
    for (const [userId, perDay] of pending) {
        for (const [day, secs] of perDay) {
            if (day >= from && day <= to)
                bump(userId, day, secs);
        }
    }
    const profile = new Map(members.map((m) => [m.id, m]));
    const out = [];
    for (const [userId, t] of totals) {
        const p = profile.get(userId);
        out.push({
            userId,
            fullName: p?.fullName ?? p?.tag ?? userId,
            batch: p?.batch ?? null,
            project: p?.project ?? null,
            module: p?.module ?? null,
            pod: p?.pod ?? null,
            seconds: t.seconds,
            daysActive: t.days.size,
            avgSecondsPerActiveDay: t.days.size > 0 ? Math.round(t.seconds / t.days.size) : 0,
            live: pending.has(userId),
        });
    }
    return out.sort((a, b) => b.seconds - a.seconds);
}
/** Org-wide voice seconds and distinct active members per day. */
export async function voiceByDay(range) {
    const { guildId, from, to } = range;
    const [rows, pending] = await Promise.all([
        prisma.attendance.findMany({
            where: { guildId, day: { gte: from, lte: to }, seconds: { gt: 0 } },
            select: { userId: true, day: true, seconds: true },
        }),
        pendingByUser(guildId),
    ]);
    const byDay = new Map();
    const bump = (day, userId, seconds) => {
        if (day < from || day > to || seconds <= 0)
            return;
        const d = byDay.get(day) ?? { seconds: 0, members: new Set() };
        d.seconds += seconds;
        d.members.add(userId);
        byDay.set(day, d);
    };
    for (const r of rows)
        bump(r.day, r.userId, r.seconds);
    for (const [userId, perDay] of pending)
        for (const [day, secs] of perDay)
            bump(day, userId, secs);
    const out = [];
    for (let day = from; day <= to; day = shiftDayKey(day, 1)) {
        const d = byDay.get(day);
        out.push({ day, seconds: d?.seconds ?? 0, members: d?.members.size ?? 0 });
    }
    return out;
}
/** Who is connected right now, and for how long. */
export async function liveVoice(guildId) {
    const open = await prisma.voiceSession.findMany({
        where: { guildId, leftAt: null },
        orderBy: { joinedAt: "asc" },
    });
    if (open.length === 0)
        return [];
    const members = await prisma.member.findMany({
        where: { id: { in: open.map((s) => s.userId) } },
        select: { id: true, fullName: true, tag: true, project: true, module: true, pod: true },
    });
    const profile = new Map(members.map((m) => [m.id, m]));
    const now = Date.now();
    return open.map((s) => {
        const p = profile.get(s.userId);
        return {
            userId: s.userId,
            fullName: p?.fullName ?? p?.tag ?? s.userId,
            project: p?.project ?? null,
            module: p?.module ?? null,
            pod: p?.pod ?? null,
            channelId: s.channelId,
            joinedAt: s.joinedAt,
            seconds: Math.max(0, Math.round((now - s.joinedAt.getTime()) / 1000)),
        };
    });
}
/** "HH:MM" in the org timezone → the UTC instant on that local day. */
function localTimeOn(day, hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    return new Date(tzDayStartUtc(day).getTime() + ((h ?? 0) * 60 + (m ?? 0)) * 60_000);
}
/** ISO weekday (1 = Mon … 7 = Sun) of a YYYY-MM-DD key. */
function isoWeekday(day) {
    const d = new Date(day + "T00:00:00Z").getUTCDay(); // 0 = Sun
    return d === 0 ? 7 : d;
}
/**
 * Per-member rule check for one local day: did they join inside the login
 * window, and did they serve the required hours? Members with no session that
 * day are reported absent rather than omitted, which is the whole point — the
 * old dashboard could only show people who had already accumulated time.
 */
export async function complianceForDay(guildId, day) {
    const policy = org.attendancePolicy;
    const dayStart = tzDayStartUtc(day);
    const dayEnd = tzDayStartUtc(shiftDayKey(day, 1));
    const loginCutoff = localTimeOn(day, policy.loginBy);
    const windowEnd = localTimeOn(day, policy.windowEnd);
    const requiredSeconds = Math.round(policy.minHours * 3600);
    const holiday = (await holidayMap(guildId)).get(day) ?? null;
    const workday = policy.workdays.includes(isoWeekday(day)) && !holiday;
    const now = new Date();
    const isToday = day === tzDateKey(now);
    // Days before tracking began have no data because nothing was recording, so
    // they must not be reported as absences.
    const untracked = Boolean(policy.trackingStartsOn && day < policy.trackingStartsOn);
    const [members, attendance, sessions, lastSessions] = await Promise.all([
        prisma.member.findMany({
            where: { guildId, status: { not: "former" } },
            select: {
                id: true,
                fullName: true,
                tag: true,
                batch: true,
                project: true,
                module: true,
                pod: true,
            },
        }),
        prisma.attendance.findMany({
            where: { guildId, day },
            select: { userId: true, seconds: true },
        }),
        // Sessions overlapping the local day, for the first-join time.
        prisma.voiceSession.findMany({
            where: {
                guildId,
                joinedAt: { lt: dayEnd },
                OR: [{ leftAt: null }, { leftAt: { gt: dayStart } }],
            },
            select: { userId: true, joinedAt: true, leftAt: true },
            orderBy: { joinedAt: "asc" },
        }),
        // Most recent close per member, for "last activity" (live members get `now`).
        prisma.voiceSession.groupBy({
            by: ["userId"],
            where: { guildId, leftAt: { not: null } },
            _max: { leftAt: true },
        }),
    ]);
    const secondsByUser = new Map(attendance.map((a) => [a.userId, a.seconds]));
    const pending = await pendingByUser(guildId);
    for (const [userId, perDay] of pending) {
        const extra = perDay.get(day);
        if (extra)
            secondsByUser.set(userId, (secondsByUser.get(userId) ?? 0) + extra);
    }
    const firstJoin = new Map();
    const liveUsers = new Set();
    for (const s of sessions) {
        // A session that started yesterday and ran into today counts as presence
        // from midnight, not as a late login.
        const effective = s.joinedAt < dayStart ? dayStart : s.joinedAt;
        if (!firstJoin.has(s.userId))
            firstJoin.set(s.userId, effective);
        if (!s.leftAt)
            liveUsers.add(s.userId);
    }
    const lastSeen = new Map();
    for (const g of lastSessions) {
        if (g._max.leftAt)
            lastSeen.set(g.userId, g._max.leftAt);
    }
    // Anyone connected right now is "last seen" now, whatever their history says.
    const liveNowUsers = await prisma.voiceSession.findMany({
        where: { guildId, leftAt: null },
        select: { userId: true },
        distinct: ["userId"],
    });
    for (const l of liveNowUsers)
        lastSeen.set(l.userId, now);
    const rows = members.map((m) => {
        const seconds = secondsByUser.get(m.id) ?? 0;
        const first = firstJoin.get(m.id) ?? null;
        const live = liveUsers.has(m.id);
        const loginOnTime = first !== null && first <= loginCutoff;
        const metHours = seconds >= requiredSeconds;
        // Mid-day, a shortfall isn't a breach yet — the member is still working.
        // Only call it short once the window has closed and they've disconnected.
        const stillEarning = isToday && (live || now < windowEnd);
        let status;
        if (untracked)
            status = "untracked";
        else if (!workday)
            status = "off-day";
        else if (first === null)
            status = isToday && now <= loginCutoff ? "not-joined-yet" : "absent";
        else if (loginOnTime && metHours)
            status = "compliant";
        else if (!loginOnTime && metHours)
            status = "late-login";
        else if (!loginOnTime)
            status = stillEarning ? "late-login" : "late-and-short";
        else
            status = stillEarning ? "in-progress" : "short-hours";
        return {
            userId: m.id,
            fullName: m.fullName ?? m.tag ?? m.id,
            batch: m.batch,
            project: m.project,
            module: m.module,
            pod: m.pod,
            seconds,
            requiredSeconds,
            firstJoinAt: first,
            lastSeenAt: lastSeen.get(m.id) ?? null,
            live,
            loginOnTime,
            metHours,
            status,
        };
    });
    rows.sort((a, b) => b.seconds - a.seconds);
    return {
        day,
        workday,
        holiday,
        policy: {
            windowStart: policy.windowStart,
            loginBy: policy.loginBy,
            windowEnd: policy.windowEnd,
            minHours: policy.minHours,
        },
        rows,
    };
}
export async function voiceOverview(range) {
    const [byMember, days, live] = await Promise.all([
        voiceByMember(range),
        voiceByDay(range),
        liveVoice(range.guildId),
    ]);
    const today = tzDateKey(new Date());
    const todayRow = days.find((d) => d.day === today);
    return {
        from: range.from,
        to: range.to,
        today,
        liveNow: live.length,
        activeToday: todayRow?.members ?? 0,
        totalSeconds: days.reduce((a, d) => a + d.seconds, 0),
        trackedMembers: byMember.length,
    };
}
//# sourceMappingURL=voiceStats.js.map