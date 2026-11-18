import { VoiceState, type Client } from "discord.js";
import { Prisma } from "@prisma/client";
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
export const MAX_SESSION_SECONDS = 12 * HOUR;

/** How often open sessions are checkpointed into Attendance and reconciled. */
export const FLUSH_INTERVAL_MS = 60_000;

/** Sessions closed concurrently by the shutdown close (one-off, speed matters). */
const WRITE_BATCH = 25;

/**
 * Sessions claimed concurrently by the every-minute flush. Kept well under the
 * connection pool so interactions always find a free connection.
 */
const FLUSH_CONCURRENCY = 4;

/** Rows per multi-row Attendance INSERT. */
const INSERT_CHUNK = 200;

let flushTimer: NodeJS.Timeout | null = null;
let sweeping = false;

/** Day bucket (YYYY-MM-DD) in the ORG timezone, not UTC. */
function dayKey(d: Date): string {
  return tzDateKey(d);
}

/** The shape of a VoiceSession row this module needs to credit time. */
interface SessionRow {
  id: number;
  guildId: string;
  userId: string;
  joinedAt: Date;
  creditedUpTo: Date | null;
  seconds: number | null;
}

async function ensureMember(guildId: string, userId: string, tag?: string) {
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
async function addDailySeconds(
  guildId: string,
  userId: string,
  day: string,
  seconds: number
): Promise<void> {
  if (seconds <= 0) return;
  // One statement instead of upsert + read-back + clamp: the flush sweep calls
  // this for every open session every minute, and three round trips each was a
  // large part of the write load that made SQLite time out. MIN() applies the
  // 24h ceiling atomically, which also removes the read-modify-write race.
  // MySQL/TiDB dialect: backtick identifiers, ON DUPLICATE KEY UPDATE (which
  // fires on the @@unique([guildId, userId, day]) index), and LEAST() for the
  // scalar minimum — MySQL's MIN() is an aggregate and would not compile here.
  await prisma.$executeRaw`
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
 *
 * The mark is claimed BEFORE any seconds are added, and only if it is still the
 * value this row was read with. Flushes and join/leave events run concurrently
 * from their own reads; without the claim, each one credited the same span and
 * a slow writer could move the mark backwards so the span was credited again.
 * If the process dies between the claim and the add, the worst case is one
 * minute under-credited, never hours over.
 */
async function creditSession(s: SessionRow, upTo: Date): Promise<number> {
  const buckets = await claimSession(s, upTo);
  for (const b of buckets) await addDailySeconds(s.guildId, s.userId, b.day, b.seconds);
  return buckets.reduce((sum, b) => sum + b.seconds, 0);
}

/**
 * The claim half of creditSession: advance the mark and return the day buckets
 * now owed to Attendance (empty if another writer got there first or nothing is
 * owed). The caller MUST add them; the flush sweep adds all of them in bulk.
 */
async function claimSession(
  s: SessionRow,
  upTo: Date
): Promise<{ day: string; seconds: number }[]> {
  let row = s;
  // Two tries: a lost claim re-reads once, so a close still credits its tail.
  for (let attempt = 0; attempt < 2; attempt++) {
    const from = row.creditedUpTo ?? row.joinedAt;
    if (upTo.getTime() <= from.getTime()) return [];

    const already = row.seconds ?? 0;
    const remaining = Math.max(0, MAX_SESSION_SECONDS - already);
    const rawSeconds = Math.round((upTo.getTime() - from.getTime()) / 1000);
    const end =
      rawSeconds > remaining ? new Date(from.getTime() + remaining * 1000) : upTo;
    // Over the per-session cap this is empty: stop crediting but keep the mark
    // moving so we don't re-walk the same span every sweep.
    const buckets = splitByTzDay(from, end);
    const credited = buckets.reduce((sum, b) => sum + b.seconds, 0);

    const claim = await prisma.voiceSession.updateMany({
      where: { id: row.id, creditedUpTo: row.creditedUpTo, leftAt: null },
      data: { creditedUpTo: upTo, seconds: already + credited },
    });
    if (claim.count === 1) return buckets.filter((b) => b.seconds > 0);

    const fresh = await prisma.voiceSession.findUnique({ where: { id: row.id } });
    if (!fresh || fresh.leftAt) return [];
    row = fresh;
  }
  return [];
}

/**
 * Add many (member, day) amounts in multi-row statements: same per-row effect
 * as addDailySeconds (24h ceiling via LEAST), a handful of round trips instead
 * of one per open session per minute.
 */
async function addDailySecondsBulk(
  items: { guildId: string; userId: string; day: string; seconds: number }[]
): Promise<void> {
  // One row per (member, day): a duplicate key inside one INSERT would still
  // sum correctly, but merging keeps the statement small.
  const merged = new Map<string, { guildId: string; userId: string; day: string; seconds: number }>();
  for (const it of items) {
    if (it.seconds <= 0) continue;
    const key = `${it.guildId}|${it.userId}|${it.day}`;
    const prev = merged.get(key);
    if (prev) prev.seconds += it.seconds;
    else merged.set(key, { ...it });
  }
  const rows = [...merged.values()];
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const values = rows
      .slice(i, i + INSERT_CHUNK)
      .map((r) => Prisma.sql`(${r.guildId}, ${r.userId}, ${r.day}, ${Math.min(r.seconds, DAY_SECONDS)})`);
    // VALUES(col) is the row's own inserted value (already capped above). The
    // new total is capped again, so the 24h ceiling holds exactly as before.
    await prisma.$executeRaw`
      INSERT INTO \`Attendance\` (\`guildId\`, \`userId\`, \`day\`, \`seconds\`)
      VALUES ${Prisma.join(values)}
      ON DUPLICATE KEY UPDATE \`seconds\` = LEAST(\`seconds\` + VALUES(\`seconds\`), ${DAY_SECONDS})
    `;
  }
}

/** Credit up to `endTime` and mark the session closed. */
async function closeSession(s: SessionRow, endTime: Date): Promise<void> {
  await ensureMember(s.guildId, s.userId);
  await creditSession(s, endTime);
  await prisma.voiceSession.update({
    where: { id: s.id },
    data: { leftAt: endTime },
  });
}

/** Close every open session for a user (defensive orphan cleanup). */
async function closeOpenSessionsForUser(
  guildId: string,
  userId: string,
  endTime: Date
): Promise<void> {
  const open = await prisma.voiceSession.findMany({
    where: { guildId, userId, leftAt: null },
  });
  for (const s of open) await closeSession(s, endTime);
}

export async function handleVoiceJoin(state: VoiceState): Promise<void> {
  // VoiceState is a LIVE cache object — its channelId can flip to null while we
  // await below (user disconnects mid-handler). Snapshot everything up front.
  const channelId = state.channelId;
  const guildId = state.guild.id;
  const userId = state.id;
  const tag = state.member?.user.tag;
  if (!channelId) return;
  if (state.member?.user.bot) return;
  await ensureMember(guildId, userId, tag);
  // A member should never have two open sessions. If a prior leave/move event
  // was missed (gateway drop), close the stale session before opening a new one
  // so it can't linger and later be credited as a huge dangling span.
  await closeOpenSessionsForUser(guildId, userId, new Date());
  await prisma.voiceSession.create({
    data: { guildId, userId, channelId },
  });
}

export async function handleVoiceLeave(state: VoiceState): Promise<void> {
  if (state.member?.user.bot) return;
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
export async function flushOpenSessions(): Promise<number> {
  const open = await prisma.voiceSession.findMany({ where: { leftAt: null } });
  if (open.length === 0) return 0;
  const now = new Date();
  let credited = 0;
  const owed: { guildId: string; userId: string; day: string; seconds: number }[] = [];
  // Claims run a few at a time, not 25: this sweep runs every minute with
  // 300+ people in voice, and 25 parallel writes took the whole connection
  // pool, so ticket buttons and slash commands timed out waiting for one.
  for (let i = 0; i < open.length; i += FLUSH_CONCURRENCY) {
    await Promise.all(
      open.slice(i, i + FLUSH_CONCURRENCY).map(async (s) => {
        try {
          const buckets = await claimSession(s, now);
          if (buckets.length > 0) credited++;
          for (const b of buckets) owed.push({ guildId: s.guildId, userId: s.userId, ...b });
        } catch (err) {
          logger.warn({ err, session: s.id }, "Could not checkpoint voice session");
        }
      })
    );
  }
  // Marks are already claimed, so these seconds belong to us alone. A failure
  // here loses this minute (same as a crash between claim and add), never
  // double-credits.
  if (owed.length > 0) await addDailySecondsBulk(owed);
  return credited;
}

/**
 * Make the DB agree with Discord's actual voice state. Gateway events get
 * dropped (resumes, rate limits, brief outages), which used to leave real
 * presence untracked (member in a VC with no open session → no attendance →
 * "absent") or phantom sessions open forever. This runs every sweep and repairs
 * both directions.
 */
export async function reconcileVoiceSessions(
  client: Client
): Promise<{ opened: number; closed: number }> {
  const now = new Date();

  // Ground truth from the gateway's voice-state cache (keyed guildId:userId).
  const live = new Map<string, { guildId: string; userId: string; channelId: string }>();
  for (const guild of client.guilds.cache.values()) {
    for (const vs of guild.voiceStates.cache.values()) {
      if (!vs.channelId) continue;
      if (vs.member?.user.bot) continue;
      live.set(`${guild.id}:${vs.id}`, {
        guildId: guild.id,
        userId: vs.id,
        channelId: vs.channelId,
      });
    }
  }

  const open = await prisma.voiceSession.findMany({ where: { leftAt: null } });
  const tracked = new Set<string>();
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
    if (actual.channelId !== s.channelId) {
      // Missed a channel move. Do NOT relabel the session in place: that would
      // retroactively credit all its elapsed time to the new channel. Close it
      // at now (crediting the old channel) and leave the member untracked so the
      // loop below opens a fresh session in the actual channel, like a real move.
      await closeSession(s, now);
      closed++;
      continue;
    }
    tracked.add(key);
  }

  for (const [key, l] of live) {
    if (tracked.has(key)) continue;
    await ensureMember(l.guildId, l.userId);
    await prisma.voiceSession.create({
      data: { guildId: l.guildId, userId: l.userId, channelId: l.channelId, joinedAt: now },
    });
    opened++;
  }

  if (opened || closed) logger.info({ opened, closed }, "Reconciled voice sessions");
  return { opened, closed };
}

/**
 * On boot, close any session left open by a hard crash. Because the flush sweep
 * checkpoints every minute, everything up to the crash is already credited — we
 * close at the high-water mark and credit NOTHING extra, so downtime is never
 * counted as presence and at most one flush interval is lost.
 */
export async function closeStaleSessionsOnBoot(): Promise<number> {
  // One statement: a row-by-row update was ~1 s per session over the remote
  // database, so a daytime restart with ~280 sessions left open blocked login
  // for 5-7 minutes. Same result per row: leftAt = checkpoint (or joinedAt if
  // never checkpointed), seconds unchanged (0 if never credited).
  const count = await prisma.$executeRaw`
    UPDATE \`VoiceSession\`
    SET \`leftAt\` = COALESCE(\`creditedUpTo\`, \`joinedAt\`),
        \`seconds\` = COALESCE(\`seconds\`, 0)
    WHERE \`leftAt\` IS NULL
  `;
  if (count > 0) {
    logger.warn({ count }, "Closed stale voice sessions at last checkpoint (crash recovery)");
  }
  return count;
}

/**
 * On graceful shutdown, close all open sessions crediting their real elapsed
 * time. This is what keeps deploys from leaving dangling sessions.
 */
export async function closeAllOpenSessions(): Promise<number> {
  const open = await prisma.voiceSession.findMany({ where: { leftAt: null } });
  if (open.length === 0) return 0;
  const now = new Date();
  // In parallel batches: one at a time, a full server (200+ people in voice)
  // took minutes over the remote database and the host had to kill the
  // process. Anything not closed here is recovered at boot from the last
  // checkpoint (closeStaleSessionsOnBoot).
  for (let i = 0; i < open.length; i += WRITE_BATCH) {
    await Promise.all(open.slice(i, i + WRITE_BATCH).map((s) => closeSession(s, now).catch(() => {})));
  }
  logger.info({ count: open.length }, "Closed open voice sessions on shutdown");
  return open.length;
}

/**
 * On boot (after ClientReady), open fresh sessions for members already sitting
 * in a voice channel, so tracking continues without them having to rejoin.
 */
export async function reopenActiveSessions(client: Client): Promise<number> {
  const { opened } = await reconcileVoiceSessions(client);
  if (opened > 0) logger.info({ count: opened }, "Reopened active voice sessions on boot");
  return opened;
}

/**
 * One checkpoint + reconcile. Returns false if skipped because the previous one
 * is still running: setInterval doesn't wait, and overlapping sweeps were how
 * members came to be credited for two or three times their real voice hours.
 */
export async function runAttendanceSweep(client: Client): Promise<boolean> {
  if (sweeping) {
    logger.warn("Attendance sweep still running, skipping this tick");
    return false;
  }
  sweeping = true;
  try {
    await reconcileVoiceSessions(client);
    await flushOpenSessions();
  } catch (err) {
    logger.error({ err }, "Attendance sweep failed");
  } finally {
    sweeping = false;
  }
  return true;
}

/** Periodic checkpoint + reconcile. Started after ClientReady. */
export function startAttendanceSweep(client: Client): void {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = setInterval(() => void runAttendanceSweep(client), FLUSH_INTERVAL_MS);
  logger.info({ everyMs: FLUSH_INTERVAL_MS }, "Attendance sweep started");
}

export function stopAttendanceSweep(): void {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
}

/**
 * Seconds accrued by a member's still-open sessions that the last flush hasn't
 * written yet, bucketed by local day. Lets reads be exact to the second instead
 * of up to a flush interval stale.
 */
export async function pendingOpenSeconds(
  guildId: string,
  userId?: string
): Promise<Map<string, Map<string, number>>> {
  const open = await prisma.voiceSession.findMany({
    where: { guildId, leftAt: null, ...(userId ? { userId } : {}) },
  });
  const now = new Date();
  const byUser = new Map<string, Map<string, number>>();
  for (const s of open) {
    const from = s.creditedUpTo ?? s.joinedAt;
    if (now.getTime() <= from.getTime()) continue;
    const perDay = byUser.get(s.userId) ?? new Map<string, number>();
    for (const b of splitByTzDay(from, now)) {
      perDay.set(b.day, (perDay.get(b.day) ?? 0) + b.seconds);
    }
    byUser.set(s.userId, perDay);
  }
  return byUser;
}

/** User IDs currently connected to voice (per the DB's open sessions). */
export async function liveUserIds(guildId: string): Promise<Set<string>> {
  const rows = await prisma.voiceSession.findMany({
    where: { guildId, leftAt: null },
    select: { userId: true },
    distinct: ["userId"],
  });
  return new Set(rows.map((r) => r.userId));
}

export interface AttendanceSummary {
  todaySeconds: number;
  weekSeconds: number;
  monthSeconds: number;
  live: boolean;
}

export async function getSummary(
  guildId: string,
  userId: string
): Promise<AttendanceSummary> {
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

  const sum = (rows: { seconds: number }[]) =>
    rows.reduce((acc, r) => acc + r.seconds, 0);

  // Top up with the still-uncredited tail of any open session.
  const perDay = pending.get(userId) ?? new Map<string, number>();
  let pendToday = 0;
  let pendWeek = 0;
  let pendMonth = 0;
  for (const [day, secs] of perDay) {
    if (day === today) pendToday += secs;
    if (day >= weekAgo) pendWeek += secs;
    if (day >= monthAgo) pendMonth += secs;
  }

  return {
    todaySeconds: (todayRow?.seconds ?? 0) + pendToday,
    weekSeconds: sum(weekRows) + pendWeek,
    monthSeconds: sum(monthRows) + pendMonth,
    live: perDay.size > 0 || (await liveUserIds(guildId)).has(userId),
  };
}

export function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
