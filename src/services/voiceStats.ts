import { prisma } from "../core/db.js";
import { holidayMap } from "./holidays.js";
import { org } from "../config/loader.js";
import { shiftDayKey, splitByTzDay, tzDateKey, tzDayStartUtc } from "../lib/time.js";

/**
 * Voice-presence reporting for the web dashboard. Runs in the web process,
 * which has no Discord client, so everything comes from the DB — including the
 * uncredited tail of sessions that are still open, so "today" is live rather
 * than a flush interval behind.
 */

export interface VoiceRange {
  guildId: string;
  from: string; // YYYY-MM-DD (org timezone), inclusive
  to: string; // YYYY-MM-DD, inclusive
}

export function defaultRange(guildId: string, days = 7): VoiceRange {
  const to = tzDateKey(new Date());
  return { guildId, from: shiftDayKey(to, -(days - 1)), to };
}

/** Uncredited seconds from still-open sessions, per user per day. */
export async function pendingByUser(
  guildId: string,
  userId?: string
): Promise<Map<string, Map<string, number>>> {
  const open = await prisma.voiceSession.findMany({
    where: { guildId, leftAt: null, ...(userId ? { userId } : {}) },
  });
  const now = new Date();
  const out = new Map<string, Map<string, number>>();
  for (const s of open) {
    const from = s.creditedUpTo ?? s.joinedAt;
    if (now.getTime() <= from.getTime()) continue;
    const perDay = out.get(s.userId) ?? new Map<string, number>();
    for (const b of splitByTzDay(from, now)) perDay.set(b.day, (perDay.get(b.day) ?? 0) + b.seconds);
    out.set(s.userId, perDay);
  }
  return out;
}

export interface VoiceMemberRow {
  userId: string;
  fullName: string;
  batch: string | null;
  project: string | null;
  module: number | null;
  pod: number | null;
  seconds: number;
  daysActive: number;
  avgSecondsPerActiveDay: number;
  live: boolean;
}

/** Per-member voice totals over a day range, live sessions included. */
export async function voiceByMember(range: VoiceRange): Promise<VoiceMemberRow[]> {
  const { guildId, from, to } = range;
  const [rows, pending, members] = await Promise.all([
    prisma.attendance.findMany({
      where: { guildId, day: { gte: from, lte: to } },
      select: { userId: true, day: true, seconds: true },
    }),
    pendingByUser(guildId),
    prisma.member.findMany({
      where: { guildId },
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

  const totals = new Map<string, { seconds: number; days: Set<string> }>();
  const bump = (userId: string, day: string, seconds: number) => {
    if (seconds <= 0) return;
    const t = totals.get(userId) ?? { seconds: 0, days: new Set<string>() };
    t.seconds += seconds;
    t.days.add(day);
    totals.set(userId, t);
  };

  for (const r of rows) bump(r.userId, r.day, r.seconds);
  for (const [userId, perDay] of pending) {
    for (const [day, secs] of perDay) {
      if (day >= from && day <= to) bump(userId, day, secs);
    }
  }

  const profile = new Map(members.map((m) => [m.id, m]));
  const out: VoiceMemberRow[] = [];
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

export interface VoiceDayRow {
  day: string;
  seconds: number;
  members: number;
}

/** Org-wide voice seconds and distinct active members per day. */
export async function voiceByDay(range: VoiceRange): Promise<VoiceDayRow[]> {
  const { guildId, from, to } = range;
  const [rows, pending] = await Promise.all([
    prisma.attendance.findMany({
      where: { guildId, day: { gte: from, lte: to }, seconds: { gt: 0 } },
      select: { userId: true, day: true, seconds: true },
    }),
    pendingByUser(guildId),
  ]);

  const byDay = new Map<string, { seconds: number; members: Set<string> }>();
  const bump = (day: string, userId: string, seconds: number) => {
    if (day < from || day > to || seconds <= 0) return;
    const d = byDay.get(day) ?? { seconds: 0, members: new Set<string>() };
    d.seconds += seconds;
    d.members.add(userId);
    byDay.set(day, d);
  };
  for (const r of rows) bump(r.day, r.userId, r.seconds);
  for (const [userId, perDay] of pending)
    for (const [day, secs] of perDay) bump(day, userId, secs);

  const out: VoiceDayRow[] = [];
  for (let day = from; day <= to; day = shiftDayKey(day, 1)) {
    const d = byDay.get(day);
    out.push({ day, seconds: d?.seconds ?? 0, members: d?.members.size ?? 0 });
  }
  return out;
}

export interface LiveRow {
  userId: string;
  fullName: string;
  project: string | null;
  module: number | null;
  pod: number | null;
  channelId: string;
  joinedAt: Date;
  seconds: number;
}

/** Who is connected right now, and for how long. */
export async function liveVoice(guildId: string): Promise<LiveRow[]> {
  const open = await prisma.voiceSession.findMany({
    where: { guildId, leftAt: null },
    orderBy: { joinedAt: "asc" },
  });
  if (open.length === 0) return [];
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

export interface VoiceOverview {
  from: string;
  to: string;
  liveNow: number;
  activeToday: number;
  totalSeconds: number;
  trackedMembers: number;
  today: string;
}

/** "HH:MM" in the org timezone → the UTC instant on that local day. */
function localTimeOn(day: string, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(tzDayStartUtc(day).getTime() + ((h ?? 0) * 60 + (m ?? 0)) * 60_000);
}

/** ISO weekday (1 = Mon … 7 = Sun) of a YYYY-MM-DD key. */
function isoWeekday(day: string): number {
  const d = new Date(day + "T00:00:00Z").getUTCDay(); // 0 = Sun
  return d === 0 ? 7 : d;
}

export type ComplianceStatus =
  | "compliant" // joined in time and served the required hours
  | "late-login" // first joined after the login cutoff
  | "short-hours" // joined in time, but finished under the required hours
  | "late-and-short" // both
  | "absent" // no voice presence at all that day
  | "in-progress" // today, on time, still accumulating — not a breach yet
  | "not-joined-yet" // today, login window still open
  | "untracked" // before attendance tracking started
  | "off-day"; // not a configured working day

export interface ComplianceRow {
  userId: string;
  fullName: string;
  batch: string | null;
  project: string | null;
  module: number | null;
  pod: number | null;
  seconds: number;
  requiredSeconds: number;
  firstJoinAt: Date | null;
  lastSeenAt: Date | null; // most recent voice activity, ANY day
  live: boolean;
  loginOnTime: boolean;
  metHours: boolean;
  status: ComplianceStatus;
}

export interface ComplianceReport {
  day: string;
  workday: boolean;
  /** Holiday name when the day is a public holiday. */
  holiday: string | null;
  policy: {
    windowStart: string;
    loginBy: string;
    windowEnd: string;
    minHours: number;
  };
  rows: ComplianceRow[];
}

/**
 * Per-member rule check for one local day: did they join inside the login
 * window, and did they serve the required hours? Members with no session that
 * day are reported absent rather than omitted, which is the whole point — the
 * old dashboard could only show people who had already accumulated time.
 */
export async function complianceForDay(
  guildId: string,
  day: string
): Promise<ComplianceReport> {
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
      where: { guildId },
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
    if (extra) secondsByUser.set(userId, (secondsByUser.get(userId) ?? 0) + extra);
  }

  const firstJoin = new Map<string, Date>();
  const liveUsers = new Set<string>();
  for (const s of sessions) {
    // A session that started yesterday and ran into today counts as presence
    // from midnight, not as a late login.
    const effective = s.joinedAt < dayStart ? dayStart : s.joinedAt;
    if (!firstJoin.has(s.userId)) firstJoin.set(s.userId, effective);
    if (!s.leftAt) liveUsers.add(s.userId);
  }

  const lastSeen = new Map<string, Date>();
  for (const g of lastSessions) {
    if (g._max.leftAt) lastSeen.set(g.userId, g._max.leftAt);
  }
  // Anyone connected right now is "last seen" now, whatever their history says.
  const liveNowUsers = await prisma.voiceSession.findMany({
    where: { guildId, leftAt: null },
    select: { userId: true },
    distinct: ["userId"],
  });
  for (const l of liveNowUsers) lastSeen.set(l.userId, now);

  const rows: ComplianceRow[] = members.map((m) => {
    const seconds = secondsByUser.get(m.id) ?? 0;
    const first = firstJoin.get(m.id) ?? null;
    const live = liveUsers.has(m.id);
    const loginOnTime = first !== null && first <= loginCutoff;
    const metHours = seconds >= requiredSeconds;

    // Mid-day, a shortfall isn't a breach yet — the member is still working.
    // Only call it short once the window has closed and they've disconnected.
    const stillEarning = isToday && (live || now < windowEnd);

    let status: ComplianceStatus;
    if (untracked) status = "untracked";
    else if (!workday) status = "off-day";
    else if (first === null) status = isToday && now <= loginCutoff ? "not-joined-yet" : "absent";
    else if (loginOnTime && metHours) status = "compliant";
    else if (!loginOnTime && metHours) status = "late-login";
    else if (!loginOnTime) status = stillEarning ? "late-login" : "late-and-short";
    else status = stillEarning ? "in-progress" : "short-hours";

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

export async function voiceOverview(range: VoiceRange): Promise<VoiceOverview> {
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
