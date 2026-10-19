import { prisma } from "../core/db.js";
import { logger } from "../core/logger.js";
import { shiftDayKey, splitByTzDay, tzDateKey } from "../lib/time.js";
const HOUR = 3600;
const DAY_SECONDS = 24 * HOUR;
/**
 * Absolute sanity cap for a SINGLE continuous voice session. The working window
 * is ~6h, so anything beyond this is a tracking artifact (a missed leave event,
 * a session left open across bot downtime) rather than real presence.
 */
const MAX_SESSION_SECONDS = 12 * HOUR;
/** How often open sessions are checkpointed into Attendance and reconciled. */
export const FLUSH_INTERVAL_MS = 60_000;
let flushTimer = null;
/** Day bucket (YYYY-MM-DD) in the ORG timezone, not UTC. */
function dayKey(d) {
    return tzDateKey(d);
}
async function ensureMember(guildId, userId, tag) {
    await prisma.member.upsert({
        where: { id: userId },
        create: { id: userId, guildId, tag },
        update: { tag },
    });
}
/**
 * Add `seconds` to a member's daily attendance total, clamping the day to a
 * physically-possible maximum (24h) as a last line of defence against inflation.
 */
async function addDailySeconds(guildId, userId, day, seconds) {
    if (seconds <= 0)
        return;
    // One statement instead of upsert + read-back + clamp: the flush sweep calls
    // this for every open session every minute, and three round trips each was a
    // large part of the write load that made SQLite time out. MIN() applies the
    // 24h ceiling atomically, which also removes the read-modify-write race.
    // MySQL/TiDB dialect: backtick identifiers, ON DUPLICATE KEY UPDATE (which
    // fires on the @@unique([guildId, userId, day]) index), and LEAST() for the
    // scalar minimum — MySQL's MIN() is an aggregate and would not compile here.
    await prisma.$executeRaw `
    INSERT INTO \`Attendance\` (\`guildId\`, \`userId\`, \`day\`, \`seconds\`)
    VALUES (${guildId}, ${userId}, ${day}, LEAST(${seconds}, ${DAY_SECONDS}))
    ON DUPLICATE KEY UPDATE \`seconds\` = LEAST(\`seconds\` + ${seconds}, ${DAY_SECONDS})
  `;
}
/**
 * Credit everything between the session's high-water mark and `upTo` into the
 * daily Attendance buckets, splitting across LOCAL midnight, then advance the
 * mark. Idempotent: calling it twice with the same `upTo` credits nothing the
 * second time, so the flush sweep can run as often as it likes.
 */
async function creditSession(s, upTo) {
    const from = s.creditedUpTo ?? s.joinedAt;
    if (upTo.getTime() <= from.getTime())
        return 0;
    const already = s.seconds ?? 0;
    const remaining = Math.max(0, MAX_SESSION_SECONDS - already);
    if (remaining === 0) {
        // Session is over the per-session cap — stop crediting but keep the mark
        // moving so we don't re-walk the same span every sweep.
        await prisma.voiceSession.update({ where: { id: s.id }, data: { creditedUpTo: upTo } });
        return 0;
    }
    const rawSeconds = Math.round((upTo.getTime() - from.getTime()) / 1000);
    const end = rawSeconds > remaining ? new Date(from.getTime() + remaining * 1000) : upTo;
    let credited = 0;
    for (const b of splitByTzDay(from, end)) {
        await addDailySeconds(s.guildId, s.userId, b.day, b.seconds);
        credited += b.seconds;
    }
    await prisma.voiceSession.update({
        where: { id: s.id },
        data: { creditedUpTo: upTo, seconds: already + credited },
    });
    return credited;
}
/** Credit up to `endTime` and mark the session closed. */
async function closeSession(s, endTime) {
    await ensureMember(s.guildId, s.userId);
    await creditSession(s, endTime);
    await prisma.voiceSession.update({
        where: { id: s.id },
        data: { leftAt: endTime },
    });
}
/** Close every open session for a user (defensive orphan cleanup). */
async function closeOpenSessionsForUser(guildId, userId, endTime) {
    const open = await prisma.voiceSession.findMany({
        where: { guildId, userId, leftAt: null },
    });
    for (const s of open)
        await closeSession(s, endTime);
}
export async function handleVoiceJoin(state) {
    // VoiceState is a LIVE cache object — its channelId can flip to null while we
    // await below (user disconnects mid-handler). Snapshot everything up front.
    const channelId = state.channelId;
    const guildId = state.guild.id;
    const userId = state.id;
    const tag = state.member?.user.tag;
    if (!channelId)
        return;
    if (state.member?.user.bot)
        return;
    await ensureMember(guildId, userId, tag);
    // A member should never have two open sessions. If a prior leave/move event
    // was missed (gateway drop), close the stale session before opening a new one
    // so it can't linger and later be credited as a huge dangling span.
    await closeOpenSessionsForUser(guildId, userId, new Date());
    await prisma.voiceSession.create({
        data: { guildId, userId, channelId },
    });
}
export async function handleVoiceLeave(state) {
    if (state.member?.user.bot)
        return;
    const now = new Date();
    await ensureMember(state.guild.id, state.id, state.member?.user.tag);
    await closeOpenSessionsForUser(state.guild.id, state.id, now);
}
/**
 * Checkpoint every open session into Attendance. Run on a timer so a member who
 * is STILL connected already counts toward today's total — the old code only
 * credited on leave, which is why anyone sitting in a VC all day read as 0
 * seconds and got reported inactive/absent.
 */
export async function flushOpenSessions() {
    const open = await prisma.voiceSession.findMany({ where: { leftAt: null } });
    if (open.length === 0)
        return 0;
    const now = new Date();
    let credited = 0;
    for (const s of open) {
        try {
            if ((await creditSession(s, now)) > 0)
                credited++;
        }
        catch (err) {
            logger.warn({ err, session: s.id }, "Could not checkpoint voice session");
        }
    }
    return credited;
}
/**
 * Make the DB agree with Discord's actual voice state. Gateway events get
 * dropped (resumes, rate limits, brief outages), which used to leave real
 * presence untracked (member in a VC with no open session → no attendance →
 * "absent") or phantom sessions open forever. This runs every sweep and repairs
 * both directions.
 */
export async function reconcileVoiceSessions(client) {
    const now = new Date();
    // Ground truth from the gateway's voice-state cache (keyed guildId:userId).
    const live = new Map();
    for (const guild of client.guilds.cache.values()) {
        for (const vs of guild.voiceStates.cache.values()) {
            if (!vs.channelId)
                continue;
            if (vs.member?.user.bot)
                continue;
            live.set(`${guild.id}:${vs.id}`, {
                guildId: guild.id,
                userId: vs.id,
                channelId: vs.channelId,
            });
        }
    }
    const open = await prisma.voiceSession.findMany({ where: { leftAt: null } });
    const tracked = new Set();
    let opened = 0;
    let closed = 0;
    for (const s of open) {
        const key = `${s.guildId}:${s.userId}`;
        const actual = live.get(key);
        if (!actual || tracked.has(key)) {
            // Left without us seeing it, or a duplicate open session.
            await closeSession(s, now);
            closed++;
            continue;
        }
        tracked.add(key);
        if (actual.channelId !== s.channelId) {
            // Missed a channel move: same continuous presence, new channel.
            await prisma.voiceSession.update({
                where: { id: s.id },
                data: { channelId: actual.channelId },
            });
        }
    }
    for (const [key, l] of live) {
        if (tracked.has(key))
            continue;
        await ensureMember(l.guildId, l.userId);
        await prisma.voiceSession.create({
            data: { guildId: l.guildId, userId: l.userId, channelId: l.channelId, joinedAt: now },
        });
        opened++;
    }
    if (opened || closed)
        logger.info({ opened, closed }, "Reconciled voice sessions");
    return { opened, closed };
}
/**
 * On boot, close any session left open by a hard crash. Because the flush sweep
 * checkpoints every minute, everything up to the crash is already credited — we
 * close at the high-water mark and credit NOTHING extra, so downtime is never
 * counted as presence and at most one flush interval is lost.
 */
export async function closeStaleSessionsOnBoot() {
    const open = await prisma.voiceSession.findMany({ where: { leftAt: null } });
    if (open.length === 0)
        return 0;
    for (const s of open) {
        const end = s.creditedUpTo ?? s.joinedAt;
        await prisma.voiceSession.update({
            where: { id: s.id },
            data: { leftAt: end, seconds: s.seconds ?? 0 },
        });
    }
    logger.warn({ count: open.length }, "Closed stale voice sessions at last checkpoint (crash recovery)");
    return open.length;
}
/**
 * On graceful shutdown, close all open sessions crediting their real elapsed
 * time. This is what keeps deploys from leaving dangling sessions.
 */
export async function closeAllOpenSessions() {
    const open = await prisma.voiceSession.findMany({ where: { leftAt: null } });
    if (open.length === 0)
        return 0;
    const now = new Date();
    // In parallel batches: one at a time, a full server (200+ people in voice)
    // took minutes over the remote database and the host had to kill the
    // process. Anything not closed here is recovered at boot from the last
    // checkpoint (closeStaleSessionsOnBoot).
    const BATCH = 25;
    for (let i = 0; i < open.length; i += BATCH) {
        await Promise.all(open.slice(i, i + BATCH).map((s) => closeSession(s, now).catch(() => { })));
    }
    logger.info({ count: open.length }, "Closed open voice sessions on shutdown");
    return open.length;
}
/**
 * On boot (after ClientReady), open fresh sessions for members already sitting
 * in a voice channel, so tracking continues without them having to rejoin.
 */
export async function reopenActiveSessions(client) {
    const { opened } = await reconcileVoiceSessions(client);
    if (opened > 0)
        logger.info({ count: opened }, "Reopened active voice sessions on boot");
    return opened;
}
/** Periodic checkpoint + reconcile. Started after ClientReady. */
export function startAttendanceSweep(client) {
    if (flushTimer)
        clearInterval(flushTimer);
    flushTimer = setInterval(() => {
        void (async () => {
            try {
                await reconcileVoiceSessions(client);
                await flushOpenSessions();
            }
            catch (err) {
                logger.error({ err }, "Attendance sweep failed");
            }
        })();
    }, FLUSH_INTERVAL_MS);
    logger.info({ everyMs: FLUSH_INTERVAL_MS }, "Attendance sweep started");
}
export function stopAttendanceSweep() {
    if (flushTimer)
        clearInterval(flushTimer);
    flushTimer = null;
}
/**
 * Seconds accrued by a member's still-open sessions that the last flush hasn't
 * written yet, bucketed by local day. Lets reads be exact to the second instead
 * of up to a flush interval stale.
 */
export async function pendingOpenSeconds(guildId, userId) {
    const open = await prisma.voiceSession.findMany({
        where: { guildId, leftAt: null, ...(userId ? { userId } : {}) },
    });
    const now = new Date();
    const byUser = new Map();
    for (const s of open) {
        const from = s.creditedUpTo ?? s.joinedAt;
        if (now.getTime() <= from.getTime())
            continue;
        const perDay = byUser.get(s.userId) ?? new Map();
        for (const b of splitByTzDay(from, now)) {
            perDay.set(b.day, (perDay.get(b.day) ?? 0) + b.seconds);
        }
        byUser.set(s.userId, perDay);
    }
    return byUser;
}
/** User IDs currently connected to voice (per the DB's open sessions). */
export async function liveUserIds(guildId) {
    const rows = await prisma.voiceSession.findMany({
        where: { guildId, leftAt: null },
        select: { userId: true },
        distinct: ["userId"],
    });
    return new Set(rows.map((r) => r.userId));
}
export async function getSummary(guildId, userId) {
    const now = new Date();
    const today = dayKey(now);
    const weekAgo = shiftDayKey(today, -6); // today + 6 previous days
    const monthAgo = shiftDayKey(today, -29);
    const [todayRow, weekRows, monthRows, pending] = await Promise.all([
        prisma.attendance.findUnique({
            where: { guildId_userId_day: { guildId, userId, day: today } },
        }),
        prisma.attendance.findMany({ where: { guildId, userId, day: { gte: weekAgo } } }),
        prisma.attendance.findMany({ where: { guildId, userId, day: { gte: monthAgo } } }),
        pendingOpenSeconds(guildId, userId),
    ]);
    const sum = (rows) => rows.reduce((acc, r) => acc + r.seconds, 0);
    // Top up with the still-uncredited tail of any open session.
    const perDay = pending.get(userId) ?? new Map();
    let pendToday = 0;
    let pendWeek = 0;
    let pendMonth = 0;
    for (const [day, secs] of perDay) {
        if (day === today)
            pendToday += secs;
        if (day >= weekAgo)
            pendWeek += secs;
        if (day >= monthAgo)
            pendMonth += secs;
    }
    return {
        todaySeconds: (todayRow?.seconds ?? 0) + pendToday,
        weekSeconds: sum(weekRows) + pendWeek,
        monthSeconds: sum(monthRows) + pendMonth,
        live: perDay.size > 0 || (await liveUserIds(guildId)).has(userId),
    };
}
export function fmtDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
}
//# sourceMappingURL=attendance.js.map