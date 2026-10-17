import { prisma, withDbRetry } from "../core/db.js";
import { org } from "../config/loader.js";
import { shiftDayKey, tzDateKey, tzDayStartUtc } from "../lib/time.js";
import { buildCalendars, type CalendarDay, type MemberCalendar } from "./calendar.js";

/**
 * Derived analytics for the dashboard: what the Overview and the member
 * profile show beyond raw calendars. Everything is computed from
 * buildCalendars, so a "violation" here means exactly what the calendar
 * colours mean — a partial day is a late login and/or short hours, a missing
 * day is an absence.
 */

export type ViolationKind =
  | "absent"
  | "late-login"
  | "short-hours"
  | "meeting-absent"
  | "meeting-late"
  | "warning";

export interface Violation {
  kind: ViolationKind;
  severity: "high" | "medium" | "low";
  day: string;
  /** Human sentence, e.g. "Joined 14:42 — 42 min after the 14:00 cutoff". */
  detail: string;
  minutesLate?: number;
  servedSeconds?: number;
  requiredSeconds?: number;
}

function policy() {
  return org.attendancePolicy;
}

function requiredSeconds(): number {
  return Math.round(policy().minHours * 3600);
}

function localTimeOn(day: string, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(tzDayStartUtc(day).getTime() + ((h ?? 0) * 60 + (m ?? 0)) * 60_000);
}

/** Minutes since local midnight for an instant on a given local day. */
function minutesIntoDay(day: string, at: Date): number {
  return Math.round((at.getTime() - tzDayStartUtc(day).getTime()) / 60_000);
}

function hhmm(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function hm(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/**
 * Last day whose verdict is final. Before the window closes today is still in
 * progress — a 10:00 "missing" is not an absence yet.
 */
function settledThrough(): string {
  const today = tzDateKey(new Date());
  return new Date() >= localTimeOn(today, policy().windowEnd) ? today : shiftDayKey(today, -1);
}

function isWorkday(day: string): boolean {
  const d = new Date(day + "T00:00:00Z").getUTCDay();
  return policy().workdays.includes(d === 0 ? 7 : d);
}

function trackingStart(): string {
  return policy().trackingStartsOn ?? "2026-01-01";
}

/** Violations a single calendar day represents (none for good/off/leave). */
function dayViolations(d: CalendarDay): Violation[] {
  const p = policy();
  const req = requiredSeconds();
  if (d.status === "missing") {
    return [
      {
        kind: "absent",
        severity: "high",
        day: d.day,
        detail: `No voice presence on a working day (needed ${p.minHours}h, join by ${p.loginBy})`,
        servedSeconds: 0,
        requiredSeconds: req,
      },
    ];
  }
  if (d.status !== "partial") return [];
  const out: Violation[] = [];
  if (!d.onTime && d.firstJoinAt) {
    const late = Math.max(
      0,
      Math.round((d.firstJoinAt.getTime() - localTimeOn(d.day, p.loginBy).getTime()) / 60_000)
    );
    out.push({
      kind: "late-login",
      severity: late >= 120 ? "high" : late >= 30 ? "medium" : "low",
      day: d.day,
      detail: `Joined ${hhmm(minutesIntoDay(d.day, d.firstJoinAt))} — ${late} min after the ${p.loginBy} cutoff`,
      minutesLate: late,
    });
  }
  if (d.seconds < req) {
    const short = req - d.seconds;
    out.push({
      kind: "short-hours",
      severity: d.seconds < req / 2 ? "high" : short >= 3600 ? "medium" : "low",
      day: d.day,
      detail: `Served ${hm(d.seconds)} of ${hm(req)} — ${hm(short)} short`,
      servedSeconds: d.seconds,
      requiredSeconds: req,
    });
  }
  return out;
}

function rate(good: number, partial: number, missing: number): number {
  const n = good + partial + missing;
  return n === 0 ? 0 : Math.round((good / n) * 1000) / 10;
}

// ---------------------------------------------------------------- org view

export interface OrgInsights {
  range: { from: string; to: string; settledThrough: string };
  policy: { loginBy: string; minHours: number; windowStart: string; windowEnd: string };
  members: number;
  activeMembers: number;
  /** Registered (has a project) but no voice presence at all in the range. */
  inactiveMembers: number;
  /** No project assigned — unregistered or unverified accounts. */
  unassignedMembers: number;
  totals: {
    good: number;
    partial: number;
    missing: number;
    leave: number;
    late: number;
    short: number;
    lateAndShort: number;
    voiceSeconds: number;
  };
  complianceRate: number;
  avgLateMinutes: number;
  trend: {
    day: string;
    workday: boolean;
    settled: boolean;
    good: number;
    partial: number;
    missing: number;
    leave: number;
    active: number;
    seconds: number;
    rate: number;
  }[];
  arrivals: { label: string; count: number; late: boolean }[];
  projects: {
    project: string;
    members: number;
    active: number;
    good: number;
    partial: number;
    missing: number;
    leave: number;
    rate: number;
    voiceSeconds: number;
    avgSecondsPerPresentDay: number;
  }[];
  topViolators: {
    userId: string;
    fullName: string;
    project: string | null;
    batch: string | null;
    absent: number;
    late: number;
    short: number;
    avgLateMinutes: number;
    rate: number;
    score: number;
  }[];
  topPerformers: {
    userId: string;
    fullName: string;
    project: string | null;
    good: number;
    rate: number;
    voiceSeconds: number;
  }[];
  latestWorkday: {
    day: string;
    good: number;
    late: number;
    short: number;
    lateAndShort: number;
    absent: number;
    leave: number;
  } | null;
  pendingLeaves: number;
  openTickets: number;
  warnings: number;
  meetings: {
    id: number;
    title: string;
    startAt: Date;
    status: string;
    present: number;
    late: number;
    absent: number;
    excused: number;
    pct: number;
  }[];
}

const CACHE_TTL_MS = 60_000;
const orgCache = new Map<string, { at: number; value: OrgInsights }>();

export async function orgInsights(guildId: string, from: string, to: string): Promise<OrgInsights> {
  if (from < trackingStart()) from = trackingStart();
  const key = `${guildId}|${from}|${to}`;
  const hit = orgCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  // Several tabs (or StrictMode double effects) asking at once share one
  // computation instead of each queueing the same heavy queries on the pool.
  const pending = inflight.get(key);
  if (pending) return pending;
  const run = withDbRetry(() => computeOrgInsights(guildId, from, to))
    .then((value) => {
      orgCache.set(key, { at: Date.now(), value });
      if (orgCache.size > 16) orgCache.delete(orgCache.keys().next().value!);
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

const inflight = new Map<string, Promise<OrgInsights>>();

async function computeOrgInsights(guildId: string, from: string, to: string): Promise<OrgInsights> {
  const p = policy();
  const settled = settledThrough();
  const rangeStart = tzDayStartUtc(from);
  const rangeEnd = tzDayStartUtc(shiftDayKey(to, 1));

  const [calendars, pendingLeaves, openTickets, warnings, meetings] = await Promise.all([
    buildCalendars(guildId, {}, from, to),
    prisma.leaveRequest.count({ where: { guildId, status: "pending" } }),
    prisma.ticket.count({ where: { guildId, status: { in: ["open", "claimed"] } } }),
    prisma.warn.count({ where: { guildId, createdAt: { gte: rangeStart, lt: rangeEnd } } }),
    prisma.meeting.findMany({
      where: { guildId, startAt: { gte: rangeStart, lt: rangeEnd }, status: { not: "cancelled" } },
      orderBy: { startAt: "desc" },
      take: 8,
      select: { id: true, title: true, startAt: true, status: true },
    }),
  ]);

  const meetingCounts = await prisma.meetingAttendance.groupBy({
    by: ["meetingId", "status"],
    where: { meetingId: { in: meetings.map((m) => m.id) } },
    _count: { _all: true },
  });

  const totals = {
    good: 0,
    partial: 0,
    missing: 0,
    leave: 0,
    late: 0,
    short: 0,
    lateAndShort: 0,
    voiceSeconds: 0,
  };
  let lateMinutesSum = 0;
  let activeMembers = 0;
  let inactiveMembers = 0;
  let unassignedMembers = 0;

  const trendBy = new Map<string, OrgInsights["trend"][number]>();
  const projectBy = new Map<string, OrgInsights["projects"][number] & { present: number }>();
  const violators: OrgInsights["topViolators"] = [];
  const performers: OrgInsights["topPerformers"] = [];
  // Arrival histogram: first-join local time on working days, 30-minute buckets.
  const arrivalBuckets = new Map<number, number>();
  const cutoffMin = Number(p.loginBy.split(":")[0]) * 60 + Number(p.loginBy.split(":")[1]);

  for (const day of calendars[0]?.days.map((d) => d.day) ?? []) {
    trendBy.set(day, {
      day,
      workday: isWorkday(day),
      settled: day <= settled,
      good: 0,
      partial: 0,
      missing: 0,
      leave: 0,
      active: 0,
      seconds: 0,
      rate: 0,
    });
  }

  for (const cal of calendars) {
    const projectName = cal.project ?? "Unassigned";
    const proj =
      projectBy.get(projectName) ??
      {
        project: projectName,
        members: 0,
        active: 0,
        good: 0,
        partial: 0,
        missing: 0,
        leave: 0,
        rate: 0,
        voiceSeconds: 0,
        avgSecondsPerPresentDay: 0,
        present: 0,
      };
    projectBy.set(projectName, proj);
    proj.members++;

    const m = { good: 0, partial: 0, missing: 0, late: 0, short: 0, lateMin: 0, seconds: 0 };
    let anyPresence = false;
    for (const d of cal.days) {
      const t = trendBy.get(d.day)!;
      if (d.seconds > 0 || d.firstJoinAt) {
        anyPresence = true;
        t.active++;
        t.seconds += d.seconds;
        m.seconds += d.seconds;
        proj.present++;
      }
      if (d.status === "leave") {
        t.leave++;
        proj.leave++;
        totals.leave++;
      }
      if (d.day > settled) continue;
      if (d.status === "good") {
        t.good++;
        m.good++;
      } else if (d.status === "partial") {
        t.partial++;
        m.partial++;
      } else if (d.status === "missing") {
        t.missing++;
        m.missing++;
      }
      if (d.status === "partial" || d.status === "good") {
        if (d.firstJoinAt) {
          const min = minutesIntoDay(d.day, d.firstJoinAt);
          const bucket = Math.min(23 * 60 + 30, Math.max(0, Math.floor(min / 30) * 30));
          arrivalBuckets.set(bucket, (arrivalBuckets.get(bucket) ?? 0) + 1);
        }
      }
      for (const v of dayViolations(d)) {
        if (v.kind === "late-login") {
          m.late++;
          m.lateMin += v.minutesLate ?? 0;
        }
        if (v.kind === "short-hours") m.short++;
      }
      if (d.status === "partial") {
        const late = !d.onTime;
        const short = d.seconds < requiredSeconds();
        if (late && short) totals.lateAndShort++;
        else if (late) totals.late++;
        else if (short) totals.short++;
      }
    }
    if (anyPresence) {
      activeMembers++;
      proj.active++;
    }
    if (!cal.project) unassignedMembers++;
    else if (!anyPresence) inactiveMembers++;
    totals.good += m.good;
    totals.partial += m.partial;
    totals.missing += m.missing;
    totals.voiceSeconds += m.seconds;
    lateMinutesSum += m.lateMin;
    proj.good += m.good;
    proj.partial += m.partial;
    proj.missing += m.missing;
    proj.voiceSeconds += m.seconds;

    // Rankings cover registered members who actually showed up: unassigned
    // accounts and no-shows (counted in inactiveMembers) would fill the list
    // with identical 100%-absent rows and hide the people a lead can act on.
    const score = m.missing * 3 + m.late + m.short;
    if (score > 0 && cal.project && anyPresence) {
      violators.push({
        userId: cal.userId,
        fullName: cal.fullName,
        project: cal.project,
        batch: cal.batch,
        absent: m.missing,
        late: m.late,
        short: m.short,
        avgLateMinutes: m.late ? Math.round(m.lateMin / m.late) : 0,
        rate: rate(m.good, m.partial, m.missing),
        score,
      });
    }
    if (m.good > 0 && cal.project) {
      performers.push({
        userId: cal.userId,
        fullName: cal.fullName,
        project: cal.project,
        good: m.good,
        rate: rate(m.good, m.partial, m.missing),
        voiceSeconds: m.seconds,
      });
    }
  }

  const trend = [...trendBy.values()].map((t) => ({ ...t, rate: rate(t.good, t.partial, t.missing) }));

  // Latest settled working day, so a weekend Overview still shows a verdict.
  let latestWorkday: OrgInsights["latestWorkday"] = null;
  const lastDay = [...trend].reverse().find((t) => t.workday && t.settled);
  if (lastDay) {
    const snap = { day: lastDay.day, good: 0, late: 0, short: 0, lateAndShort: 0, absent: 0, leave: 0 };
    for (const cal of calendars) {
      const d = cal.days.find((x) => x.day === lastDay.day);
      if (!d) continue;
      if (d.status === "good") snap.good++;
      else if (d.status === "missing") snap.absent++;
      else if (d.status === "leave") snap.leave++;
      else if (d.status === "partial") {
        const late = !d.onTime;
        const short = d.seconds < requiredSeconds();
        if (late && short) snap.lateAndShort++;
        else if (late) snap.late++;
        else snap.short++;
      }
    }
    latestWorkday = snap;
  }

  const counts = new Map<number, Record<string, number>>();
  for (const c of meetingCounts) {
    const row = counts.get(c.meetingId) ?? {};
    row[c.status] = c._count._all;
    counts.set(c.meetingId, row);
  }

  // Arrivals from 08:00 to 20:00, with the edges folded in.
  const arrivals: OrgInsights["arrivals"] = [];
  for (let b = 8 * 60; b <= 20 * 60; b += 30) {
    let count = arrivalBuckets.get(b) ?? 0;
    if (b === 8 * 60) for (const [k, v] of arrivalBuckets) if (k < b) count += v;
    if (b === 20 * 60) for (const [k, v] of arrivalBuckets) if (k > b) count += v;
    arrivals.push({ label: hhmm(b), count, late: b >= cutoffMin });
  }

  const settledLate = totals.late + totals.lateAndShort;
  return {
    range: { from, to, settledThrough: settled },
    policy: { loginBy: p.loginBy, minHours: p.minHours, windowStart: p.windowStart, windowEnd: p.windowEnd },
    members: calendars.length,
    activeMembers,
    inactiveMembers,
    unassignedMembers,
    totals,
    complianceRate: rate(totals.good, totals.partial, totals.missing),
    avgLateMinutes: settledLate ? Math.round(lateMinutesSum / settledLate) : 0,
    trend,
    arrivals,
    projects: [...projectBy.values()]
      .map(({ present, ...p }) => ({
        ...p,
        rate: rate(p.good, p.partial, p.missing),
        avgSecondsPerPresentDay: present ? Math.round(p.voiceSeconds / present) : 0,
      }))
      .sort(
        (a, b) =>
          Number(a.project === "Unassigned") - Number(b.project === "Unassigned") ||
          b.rate - a.rate ||
          b.members - a.members
      ),
    topViolators: violators.sort((a, b) => b.score - a.score || a.rate - b.rate).slice(0, 12),
    topPerformers: performers
      .sort((a, b) => b.good - a.good || b.rate - a.rate || b.voiceSeconds - a.voiceSeconds)
      .slice(0, 10),
    latestWorkday,
    pendingLeaves,
    openTickets,
    warnings,
    meetings: meetings.map((mt) => {
      const c = counts.get(mt.id) ?? {};
      const present = c.present ?? 0;
      const late = c.late ?? 0;
      const absent = c.absent ?? 0;
      const excused = c.excused ?? 0;
      const expected = present + late + absent;
      return {
        ...mt,
        present,
        late,
        absent,
        excused,
        pct: expected ? Math.round(((present + late) / expected) * 1000) / 10 : 0,
      };
    }),
  };
}

// ------------------------------------------------------------- member view

export interface MemberInsights {
  details: {
    userId: string;
    registrationDate: Date | null;
    flagged: boolean;
    updatedAt: Date | null;
    trackedFrom: string | null;
  };
  /** Selected month (the range the profile calendar shows). */
  period: {
    from: string;
    to: string;
    complianceRate: number;
    workdays: number;
    voiceSeconds: number;
    avgSecondsPerPresentDay: number;
    onTimeRate: number;
    avgFirstJoin: string | null;
    late: number;
    short: number;
    absent: number;
  };
  lifetime: {
    from: string;
    good: number;
    partial: number;
    missing: number;
    leave: number;
    complianceRate: number;
    voiceSeconds: number;
    presentDays: number;
    currentStreak: number;
    bestStreak: number;
    absentStreak: number;
  };
  violations: Violation[];
  lifetimeViolations: { absent: number; late: number; short: number; meetingAbsent: number; meetingLate: number; warnings: number };
  meetingStats: { present: number; late: number; absent: number; excused: number; pct: number; avgMinutesLate: number };
  warns: { reason: string; by: string; at: Date }[];
  tickets: { id: number; type: string; subject: string; status: string; createdAt: Date; closedAt: Date | null }[];
  daily: { day: string; seconds: number; firstJoin: string | null; status: string }[];
  projectRank: { rank: number; of: number } | null;
}

function streaks(days: CalendarDay[], settled: string) {
  const work = days.filter((d) => d.day <= settled && ["good", "partial", "missing"].includes(d.status));
  let best = 0;
  let run = 0;
  for (const d of work) {
    run = d.status === "good" ? run + 1 : 0;
    best = Math.max(best, run);
  }
  let current = 0;
  for (let i = work.length - 1; i >= 0 && work[i]!.status === "good"; i--) current++;
  let absent = 0;
  for (let i = work.length - 1; i >= 0 && work[i]!.status === "missing"; i--) absent++;
  return { currentStreak: current, bestStreak: best, absentStreak: absent };
}

export async function memberInsights(
  guildId: string,
  userId: string,
  month: MemberCalendar | null,
  from: string,
  to: string
): Promise<MemberInsights> {
  const settled = settledThrough();
  const today = tzDateKey(new Date());
  const [member, lifetimeCal, meetings, warns, tickets] = await Promise.all([
    prisma.member.findUnique({
      where: { id: userId },
      select: { registrationDate: true, flagged: true, updatedAt: true, project: true },
    }),
    buildCalendars(guildId, { userId }, trackingStart(), today).then((a) => a[0] ?? null),
    prisma.meetingAttendance.findMany({
      where: { userId, meeting: { guildId } },
      orderBy: { scheduledStart: "desc" },
      select: { status: true, minutesLate: true, scheduledStart: true, meeting: { select: { title: true } } },
    }),
    prisma.warn.findMany({ where: { guildId, userId }, orderBy: { createdAt: "desc" } }),
    prisma.ticket.findMany({
      where: { guildId, openerId: userId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, type: true, subject: true, status: true, createdAt: true, closedAt: true },
    }),
  ]);

  const modIds = [...new Set(warns.map((w) => w.modId))];
  const mods = modIds.length
    ? await prisma.member.findMany({ where: { id: { in: modIds } }, select: { id: true, fullName: true, displayName: true, tag: true } })
    : [];
  const modName = new Map(mods.map((m) => [m.id, m.fullName ?? m.displayName ?? m.tag ?? m.id]));

  // Selected period.
  const pdays = (month?.days ?? []).filter((d) => d.day <= settled);
  const periodViolations: Violation[] = [];
  for (const d of pdays) periodViolations.push(...dayViolations(d));
  for (const mt of meetings) {
    const day = tzDateKey(mt.scheduledStart);
    if (day < from || day > to) continue;
    if (mt.status === "absent") {
      periodViolations.push({ kind: "meeting-absent", severity: "medium", day, detail: `Missed meeting “${mt.meeting.title}”` });
    } else if (mt.status === "late") {
      periodViolations.push({
        kind: "meeting-late",
        severity: mt.minutesLate >= 15 ? "medium" : "low",
        day,
        detail: `Joined “${mt.meeting.title}” ${mt.minutesLate} min late`,
        minutesLate: mt.minutesLate,
      });
    }
  }
  for (const w of warns) {
    const day = tzDateKey(w.createdAt);
    if (day < from || day > to) continue;
    periodViolations.push({ kind: "warning", severity: "high", day, detail: `Warned by ${modName.get(w.modId) ?? w.modId}: ${w.reason}` });
  }
  periodViolations.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));

  const pGood = pdays.filter((d) => d.status === "good").length;
  const pPartial = pdays.filter((d) => d.status === "partial").length;
  const pMissing = pdays.filter((d) => d.status === "missing").length;
  const present = pdays.filter((d) => d.firstJoinAt);
  const pSeconds = (month?.days ?? []).reduce((a, d) => a + d.seconds, 0);
  const presentWork = present.filter((d) => d.status === "good" || d.status === "partial");
  const joinMins = presentWork.map((d) => minutesIntoDay(d.day, d.firstJoinAt!));

  // Lifetime.
  const ldays = lifetimeCal?.days ?? [];
  const lifetimeTotals = { good: 0, partial: 0, missing: 0, leave: 0 };
  const lv = { absent: 0, late: 0, short: 0, meetingAbsent: 0, meetingLate: 0, warnings: warns.length };
  for (const d of ldays) {
    if (d.status === "leave") lifetimeTotals.leave++;
    if (d.day > settled) continue;
    if (d.status === "good") lifetimeTotals.good++;
    else if (d.status === "partial") lifetimeTotals.partial++;
    else if (d.status === "missing") lifetimeTotals.missing++;
    for (const v of dayViolations(d)) {
      if (v.kind === "absent") lv.absent++;
      if (v.kind === "late-login") lv.late++;
      if (v.kind === "short-hours") lv.short++;
    }
  }
  const ms = { present: 0, late: 0, absent: 0, excused: 0, lateMin: 0 };
  for (const mt of meetings) {
    if (mt.status === "present") ms.present++;
    else if (mt.status === "late") {
      ms.late++;
      ms.lateMin += mt.minutesLate;
      lv.meetingLate++;
    } else if (mt.status === "absent") {
      ms.absent++;
      lv.meetingAbsent++;
    } else if (mt.status === "excused") ms.excused++;
  }
  const expected = ms.present + ms.late + ms.absent;

  // Rank inside the member's project by lifetime compliance (good days, then rate).
  let projectRank: MemberInsights["projectRank"] = null;
  if (member?.project) {
    const peers = await buildCalendars(guildId, { project: member.project }, from, to);
    const scored = peers
      .map((c) => {
        const ds = c.days.filter((d) => d.day <= settled);
        const g = ds.filter((d) => d.status === "good").length;
        const pa = ds.filter((d) => d.status === "partial").length;
        const mi = ds.filter((d) => d.status === "missing").length;
        return { id: c.userId, g, r: rate(g, pa, mi), s: c.days.reduce((a, d) => a + d.seconds, 0) };
      })
      .sort((a, b) => b.g - a.g || b.r - a.r || b.s - a.s);
    const idx = scored.findIndex((s) => s.id === userId);
    if (idx !== -1) projectRank = { rank: idx + 1, of: scored.length };
  }

  return {
    details: {
      userId,
      registrationDate: member?.registrationDate ?? null,
      flagged: member?.flagged ?? false,
      updatedAt: member?.updatedAt ?? null,
      trackedFrom: lifetimeCal?.trackedFrom ?? null,
    },
    period: {
      from,
      to,
      complianceRate: rate(pGood, pPartial, pMissing),
      workdays: pGood + pPartial + pMissing,
      voiceSeconds: pSeconds,
      avgSecondsPerPresentDay: present.length ? Math.round(pSeconds / present.length) : 0,
      onTimeRate: presentWork.length
        ? Math.round((presentWork.filter((d) => d.onTime).length / presentWork.length) * 1000) / 10
        : 0,
      avgFirstJoin: joinMins.length ? hhmm(joinMins.reduce((a, b) => a + b, 0) / joinMins.length) : null,
      late: periodViolations.filter((v) => v.kind === "late-login").length,
      short: periodViolations.filter((v) => v.kind === "short-hours").length,
      absent: periodViolations.filter((v) => v.kind === "absent").length,
    },
    lifetime: {
      from: lifetimeCal?.trackedFrom ?? trackingStart(),
      ...lifetimeTotals,
      complianceRate: rate(lifetimeTotals.good, lifetimeTotals.partial, lifetimeTotals.missing),
      voiceSeconds: ldays.reduce((a, d) => a + d.seconds, 0),
      presentDays: ldays.filter((d) => d.firstJoinAt).length,
      ...streaks(ldays, settled),
    },
    violations: periodViolations,
    lifetimeViolations: lv,
    meetingStats: {
      present: ms.present,
      late: ms.late,
      absent: ms.absent,
      excused: ms.excused,
      pct: expected ? Math.round(((ms.present + ms.late) / expected) * 1000) / 10 : 0,
      avgMinutesLate: ms.late ? Math.round(ms.lateMin / ms.late) : 0,
    },
    warns: warns.map((w) => ({ reason: w.reason, by: modName.get(w.modId) ?? w.modId, at: w.createdAt })),
    tickets,
    daily: (month?.days ?? []).map((d) => ({
      day: d.day,
      seconds: d.seconds,
      firstJoin: d.firstJoinAt ? hhmm(minutesIntoDay(d.day, d.firstJoinAt)) : null,
      status: d.status,
    })),
    projectRank,
  };
}
