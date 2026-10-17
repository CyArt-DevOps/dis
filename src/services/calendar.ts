import { prisma } from "../core/db.js";
import { org, activeProjects } from "../config/loader.js";
import { shiftDayKey, splitByTzDay, tzDateKey, tzDayStartUtc } from "../lib/time.js";

/**
 * Calendar-shaped attendance: for every member in scope, a per-day status for a
 * date range. This is the data behind the profile calendar and the group
 * (batch/project/module/pod) calendars.
 */

export type DayStatus =
  | "good" // met the login window and the hours target
  | "partial" // present but late and/or short of the hours target
  | "missing" // working day with no voice presence
  | "leave" // covered by an approved leave request
  | "off" // weekend / non-working day
  | "untracked" // before tracking started, or before this member existed
  | "future"; // hasn't happened yet

export interface MemberScope {
  userId?: string; // single member (profile view)
  batch?: string;
  project?: string; // project display name as stored on Member
  module?: number;
  pod?: number;
  q?: string; // free-text name search
}

export interface CalendarDay {
  day: string;
  status: DayStatus;
  seconds: number;
  firstJoinAt: Date | null;
  onTime: boolean;
}

export interface MemberCalendar {
  userId: string;
  fullName: string;
  batch: string | null;
  project: string | null;
  module: number | null;
  pod: number | null;
  days: CalendarDay[];
  totals: { good: number; partial: number; missing: number; leave: number };
  /** First day this member's data is meaningful; earlier days are "untracked". */
  trackedFrom: string;
}

function policy() {
  return org.attendancePolicy;
}

/** "HH:MM" on a local day → UTC instant. */
function localTimeOn(day: string, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(tzDayStartUtc(day).getTime() + ((h ?? 0) * 60 + (m ?? 0)) * 60_000);
}

function isoWeekday(day: string): number {
  const d = new Date(day + "T00:00:00Z").getUTCDay();
  return d === 0 ? 7 : d;
}

export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = shiftDayKey(d, 1)) out.push(d);
  return out;
}

/** Members matching a scope, straight from the Member table. */
export async function membersInScope(guildId: string, scope: MemberScope) {
  const where: Record<string, unknown> = { guildId };
  if (scope.userId) where.id = scope.userId;
  if (scope.batch) where.batch = scope.batch;
  if (scope.project) where.project = scope.project;
  if (scope.module !== undefined) where.module = scope.module;
  if (scope.pod !== undefined) where.pod = scope.pod;
  const rows = await prisma.member.findMany({
    where,
    select: {
      id: true,
      fullName: true,
      displayName: true,
      tag: true,
      batch: true,
      project: true,
      module: true,
      pod: true,
      joinedAt: true,
    },
    orderBy: { fullName: "asc" },
  });
  const q = scope.q?.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((m) =>
    [m.fullName, m.displayName, m.tag, m.project, m.batch]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q))
  );
}

/**
 * Per-day status for every member in scope over [from, to].
 *
 * Everything is fetched in bulk (one query per source) and bucketed in memory —
 * a per-member-per-day query would be thousands of round trips for a month view.
 */
export async function buildCalendars(
  guildId: string,
  scope: MemberScope,
  from: string,
  to: string
): Promise<MemberCalendar[]> {
  const members = await membersInScope(guildId, scope);
  if (members.length === 0) return [];
  const ids = members.map((m) => m.id);
  const days = eachDay(from, to);
  const rangeStart = tzDayStartUtc(from);
  const rangeEnd = tzDayStartUtc(shiftDayKey(to, 1));
  const today = tzDateKey(new Date());
  const p = policy();
  const requiredSeconds = Math.round(p.minHours * 3600);

  const [attendance, sessions, leaves, firstData] = await Promise.all([
    prisma.attendance.findMany({
      where: { guildId, userId: { in: ids }, day: { gte: from, lte: to } },
      select: { userId: true, day: true, seconds: true },
    }),
    prisma.voiceSession.findMany({
      where: {
        guildId,
        userId: { in: ids },
        joinedAt: { lt: rangeEnd },
        OR: [{ leftAt: null }, { leftAt: { gt: rangeStart } }],
      },
      select: { userId: true, joinedAt: true, leftAt: true, creditedUpTo: true },
      orderBy: { joinedAt: "asc" },
    }),
    prisma.leaveRequest.findMany({
      where: {
        guildId,
        userId: { in: ids },
        status: "approved",
        startAt: { lt: rangeEnd },
        endAt: { gt: rangeStart },
      },
      select: { userId: true, startAt: true, endAt: true, approvedDays: true },
    }),
    // Earliest day each member has ANY recorded attendance. Used as a floor on
    // their tracked-from date so a late-created Member row (a resync, say)
    // can't hide history that actually exists.
    prisma.attendance.groupBy({
      by: ["userId"],
      where: { guildId, userId: { in: ids } },
      _min: { day: true },
    }),
  ]);

  const key = (userId: string, day: string) => userId + "|" + day;

  const secondsBy = new Map<string, number>();
  for (const a of attendance) secondsBy.set(key(a.userId, a.day), a.seconds);

  // First join per member per local day. A session that runs across midnight
  // counts as presence from 00:00 on the following day, not a late arrival.
  const firstJoinBy = new Map<string, Date>();
  const now = new Date();
  for (const s of sessions) {
    const end = s.leftAt ?? now;
    if (end <= s.joinedAt) continue;
    let first = true;
    for (const bucket of splitByTzDay(s.joinedAt, end)) {
      const k = key(s.userId, bucket.day);
      const candidate = first ? s.joinedAt : tzDayStartUtc(bucket.day);
      first = false;
      const existing = firstJoinBy.get(k);
      if (!existing || candidate < existing) firstJoinBy.set(k, candidate);
      // Open sessions haven't been checkpointed past creditedUpTo — make sure
      // the day still registers presence even if Attendance is a minute behind.
      if (!secondsBy.has(k)) secondsBy.set(k, 0);
    }
  }

  const onLeave = new Set<string>();
  for (const l of leaves) {
    if (l.approvedDays) {
      // Exam leave: only the specific days HR approved from the timetable.
      for (const d of l.approvedDays.split(",").filter(Boolean)) onLeave.add(key(l.userId, d));
      continue;
    }
    for (const d of eachDay(tzDateKey(l.startAt), tzDateKey(l.endAt))) {
      onLeave.add(key(l.userId, d));
    }
  }

  const workday = new Map(days.map((d) => [d, p.workdays.includes(isoWeekday(d))]));
  const cutoffs = new Map(days.map((d) => [d, localTimeOn(d, p.loginBy)]));

  const firstDataDay = new Map<string, string>();
  for (const g of firstData) if (g._min.day) firstDataDay.set(g.userId, g._min.day);

  // Nothing was recorded before the org started tracking, so anything earlier
  // is "no data", not "absent" — counting it as missing produced totals in the
  // thousands for days the bot wasn't even running.
  const trackingStart = p.trackingStartsOn;

  return members.map((m) => {
    // Per member: the later of the org-wide start and when this member first
    // appeared — but never later than their own earliest recorded day.
    const appeared = tzDateKey(m.joinedAt);
    const earliestData = firstDataDay.get(m.id);
    let trackedFrom = earliestData && earliestData < appeared ? earliestData : appeared;
    if (trackingStart && trackedFrom < trackingStart) trackedFrom = trackingStart;

    const totals = { good: 0, partial: 0, missing: 0, leave: 0 };
    const out: CalendarDay[] = days.map((day) => {
      const k = key(m.id, day);
      const seconds = secondsBy.get(k) ?? 0;
      const firstJoinAt = firstJoinBy.get(k) ?? null;
      const onTime = firstJoinAt !== null && firstJoinAt <= cutoffs.get(day)!;

      let status: DayStatus;
      if (day > today) status = "future";
      // Real presence always wins: if there is data for the day, show it even
      // if the day predates the computed tracked-from boundary.
      else if (day < trackedFrom && firstJoinAt === null && !onLeave.has(k)) status = "untracked";
      else if (onLeave.has(k)) status = "leave";
      else if (!workday.get(day)) status = "off";
      else if (firstJoinAt === null) status = "missing";
      else if (onTime && seconds >= requiredSeconds) status = "good";
      else status = "partial";

      if (status === "good") totals.good++;
      else if (status === "partial") totals.partial++;
      else if (status === "missing") totals.missing++;
      else if (status === "leave") totals.leave++;

      return { day, status, seconds, firstJoinAt, onTime };
    });

    return {
      userId: m.id,
      fullName: m.fullName ?? m.displayName ?? m.tag ?? m.id,
      batch: m.batch,
      project: m.project,
      module: m.module,
      pod: m.pod,
      days: out,
      totals,
      trackedFrom,
    };
  });
}

/**
 * Wire format for the group calendars. A month of 374 members serialised as
 * objects-per-day is ~1.1 MB; most days carry no detail at all, so statuses go
 * out as one character each and only days with actual presence carry a payload.
 */
export interface CompactCalendar {
  userId: string;
  fullName: string;
  batch: string | null;
  project: string | null;
  module: number | null;
  pod: number | null;
  /** One char per day, same order as the range: g/p/m/l/o/f. */
  status: string;
  /** Sparse detail, keyed by day, only where there was presence. */
  detail: Record<string, { s: number; f: string | null; o: boolean }>;
  totals: { good: number; partial: number; missing: number; leave: number };
  trackedFrom: string;
}

const STATUS_CODE: Record<DayStatus, string> = {
  good: "g",
  partial: "p",
  missing: "m",
  leave: "l",
  off: "o",
  untracked: "u",
  future: "f",
};

export function compactCalendar(c: MemberCalendar): CompactCalendar {
  const detail: CompactCalendar["detail"] = {};
  let status = "";
  for (const d of c.days) {
    status += STATUS_CODE[d.status];
    if (d.seconds > 0 || d.firstJoinAt) {
      detail[d.day] = {
        s: d.seconds,
        f: d.firstJoinAt ? d.firstJoinAt.toISOString() : null,
        o: d.onTime,
      };
    }
  }
  return {
    userId: c.userId,
    fullName: c.fullName,
    batch: c.batch,
    project: c.project,
    module: c.module,
    pod: c.pod,
    status,
    detail,
    totals: c.totals,
    trackedFrom: c.trackedFrom,
  };
}

/**
 * Short-lived cache for group calendars. Attendance only moves when the flush
 * sweep runs (once a minute), so serving a slightly stale calendar costs
 * nothing and turns a 5s rebuild into an instant response on repeat views.
 */
const CACHE_TTL_MS = 45_000;
const calendarCache = new Map<string, { at: number; value: CompactCalendar[] }>();

/** Drop cached calendars after a write (e.g. leave granted from the dashboard). */
export function clearCalendarCache(): void {
  calendarCache.clear();
}

export async function cachedCompactCalendars(
  guildId: string,
  scope: MemberScope,
  from: string,
  to: string
): Promise<CompactCalendar[]> {
  const key = JSON.stringify([guildId, scope, from, to]);
  const hit = calendarCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const value = (await buildCalendars(guildId, scope, from, to)).map(compactCalendar);
  calendarCache.set(key, { at: Date.now(), value });
  // Bound the cache: a handful of scope/month combinations is normal, but it
  // must not grow without limit from arbitrary query strings.
  if (calendarCache.size > 64) {
    const oldest = [...calendarCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) calendarCache.delete(oldest[0]);
  }
  return value;
}

export interface FilterOptions {
  batches: string[];
  projects: string[];
  modules: number[];
  pods: number[];
  policy: {
    windowStart: string;
    loginBy: string;
    windowEnd: string;
    minHours: number;
    workdays: number[];
    trackingStartsOn: string | null;
  };
}

/**
 * Values the filter dropdowns should offer: config is the source of truth for
 * batches/projects, with anything else that actually appears on a Member row
 * folded in so historical values stay selectable.
 */
export async function filterOptions(guildId: string): Promise<FilterOptions> {
  const rows = await prisma.member.findMany({
    where: { guildId },
    select: { batch: true, project: true, module: true, pod: true },
  });
  const batches = new Set<string>(org.batches);
  const projects = new Set<string>(activeProjects().map((p) => p.name));
  const modules = new Set<number>();
  const pods = new Set<number>();
  for (const r of rows) {
    if (r.batch) batches.add(r.batch);
    if (r.project) projects.add(r.project);
    if (r.module !== null) modules.add(r.module);
    if (r.pod !== null) pods.add(r.pod);
  }
  const p = policy();
  return {
    batches: [...batches].sort(),
    projects: [...projects].sort(),
    modules: [...modules].sort((a, b) => a - b),
    pods: [...pods].sort((a, b) => a - b),
    policy: {
      windowStart: p.windowStart,
      loginBy: p.loginBy,
      windowEnd: p.windowEnd,
      minHours: p.minHours,
      workdays: p.workdays,
      trackingStartsOn: p.trackingStartsOn ?? null,
    },
  };
}

export interface MemberProfile {
  member: {
    userId: string;
    fullName: string;
    displayName: string | null;
    tag: string | null;
    batch: string | null;
    project: string | null;
    module: number | null;
    pod: number | null;
    verificationStatus: string;
    joinedAt: Date;
  } | null;
  calendar: MemberCalendar | null;
  live: boolean;
  lastSeenAt: Date | null;
  meetings: {
    meetingId: number;
    title: string;
    status: string;
    minutesLate: number;
    scheduledStart: Date;
  }[];
  leaves: {
    id: number;
    type: string;
    status: string;
    startAt: Date;
    endAt: Date;
    reason: string;
    approvedDays: string | null;
    reviewedById: string | null;
    reviewedAt: Date | null;
  }[];
}

/** Everything the profile page shows for one member. */
export async function memberProfile(
  guildId: string,
  userId: string,
  from: string,
  to: string
): Promise<MemberProfile> {
  const [member, calendars, open, lastClosed, meetings, leaves] = await Promise.all([
    prisma.member.findUnique({ where: { id: userId } }),
    buildCalendars(guildId, { userId }, from, to).then((all) => all[0] ?? null),
    prisma.voiceSession.findFirst({ where: { guildId, userId, leftAt: null } }),
    prisma.voiceSession.findFirst({
      where: { guildId, userId, leftAt: { not: null } },
      orderBy: { leftAt: "desc" },
      select: { leftAt: true },
    }),
    prisma.meetingAttendance.findMany({
      where: { userId, meeting: { guildId } },
      orderBy: { scheduledStart: "desc" },
      take: 50,
      select: {
        meetingId: true,
        status: true,
        minutesLate: true,
        scheduledStart: true,
        meeting: { select: { title: true } },
      },
    }),
    prisma.leaveRequest.findMany({
      where: { guildId, userId },
      orderBy: { startAt: "desc" },
      take: 25,
      select: {
        id: true,
        type: true,
        status: true,
        startAt: true,
        endAt: true,
        reason: true,
        approvedDays: true,
        reviewedById: true,
        reviewedAt: true,
      },
    }),
  ]);

  return {
    member: member
      ? {
          userId: member.id,
          fullName: member.fullName ?? member.displayName ?? member.tag ?? member.id,
          displayName: member.displayName,
          tag: member.tag,
          batch: member.batch,
          project: member.project,
          module: member.module,
          pod: member.pod,
          verificationStatus: member.verificationStatus,
          joinedAt: member.joinedAt,
        }
      : null,
    calendar: calendars,
    live: Boolean(open),
    lastSeenAt: open ? new Date() : lastClosed?.leftAt ?? null,
    meetings: meetings.map((m) => ({
      meetingId: m.meetingId,
      title: m.meeting.title,
      status: m.status,
      minutesLate: m.minutesLate,
      scheduledStart: m.scheduledStart,
    })),
    leaves,
  };
}
