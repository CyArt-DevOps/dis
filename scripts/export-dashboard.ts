/**
 * Export a static, self-contained HTML dashboard from the bot's database.
 * No hosting needed — the output is a single file with the data embedded;
 * open dashboard/index.html directly in any browser.
 *
 *   npm run dashboard          → writes dashboard/index.html
 *   DAYS=60 npm run dashboard  → wider window (default 30 days)
 *
 * Dashboards: Overview · Daily Attendance · Meetings · Members · Leave & Warns.
 * "Day" boundaries are UTC (same dayKey the attendance tracker writes).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/core/db.js";
import { org } from "../src/config/loader.js";

const THRESHOLD_SECONDS = 5.5 * 3600; // required daily voice time
const WINDOW_DAYS = Number(process.env.DAYS ?? 30);
// Interns must JOIN voice by 2:00 PM IST. IST = UTC+5:30, and the whole working
// window (11:30–17:30 IST = 06:00–12:00 UTC) sits inside one UTC date, so the
// cutoff is simply 08:30 UTC on each day. Seconds-from-UTC-midnight:
const LOGIN_CUTOFF_UTC_SECONDS = (8 * 60 + 30) * 60; // 08:30:00 UTC = 14:00 IST

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "..", "dashboard");
const templatePath = resolve(here, "dashboard-template.html");

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

interface MemberLite {
  id: string;
  name: string;
  batch: string | null;
  project: string | null;
  module: number | null;
  pod: number | null;
}

async function main() {
  const now = new Date();
  const fromDay = dayKey(new Date(now.getTime() - WINDOW_DAYS * 86400_000));
  const fromDate = new Date(now.getTime() - WINDOW_DAYS * 86400_000);

  const [membersRaw, attendanceRows, sessionRows, meetings, leaves, warns, ticketOpen, ticketClaimed] =
    await Promise.all([
      prisma.member.findMany(),
      prisma.attendance.findMany({ where: { day: { gte: fromDay } } }),
      prisma.voiceSession.findMany({
        where: { joinedAt: { gte: fromDate } },
        select: { userId: true, joinedAt: true },
        orderBy: { joinedAt: "asc" },
      }),
      prisma.meeting.findMany({
        where: { startAt: { gte: fromDate } },
        include: { attendance: true },
        orderBy: { startAt: "desc" },
      }),
      prisma.leaveRequest.findMany({
        where: { OR: [{ endAt: { gte: fromDate } }, { status: "pending" }] },
        orderBy: { startAt: "desc" },
      }),
      prisma.warn.findMany({
        where: { createdAt: { gte: fromDate } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.ticket.count({ where: { status: "open" } }),
      prisma.ticket.count({ where: { status: "claimed" } }),
    ]);

  const nameOf = (m: (typeof membersRaw)[number]) =>
    m.fullName ?? m.displayName ?? m.tag ?? m.id;

  // Roster = verified members (they're the ones expected in voice daily).
  const verified = membersRaw.filter((m) => m.verificationStatus === "verified");
  const roster: MemberLite[] = (verified.length > 0 ? verified : membersRaw).map((m) => ({
    id: m.id,
    name: nameOf(m),
    batch: m.batch,
    project: m.project,
    module: m.module,
    pod: m.pod,
  }));
  const rosterIds = new Set(roster.map((m) => m.id));
  const nameById = new Map(membersRaw.map((m) => [m.id, nameOf(m)]));

  // Approved-leave day coverage: exam leave uses approvedDays CSV, others the range.
  const leaveDays = new Map<string, Set<string>>(); // day -> userIds
  for (const l of leaves) {
    if (l.status !== "approved") continue;
    const days: string[] = [];
    if (l.approvedDays) {
      days.push(...l.approvedDays.split(",").map((s) => s.trim()).filter(Boolean));
    } else {
      for (
        let t = Date.UTC(l.startAt.getUTCFullYear(), l.startAt.getUTCMonth(), l.startAt.getUTCDate());
        t <= l.endAt.getTime();
        t += 86400_000
      )
        days.push(dayKey(new Date(t)));
    }
    for (const d of days) {
      if (!leaveDays.has(d)) leaveDays.set(d, new Set());
      leaveDays.get(d)!.add(l.userId);
    }
  }

  // Attendance rows grouped by day.
  const byDay = new Map<string, { userId: string; seconds: number }[]>();
  for (const r of attendanceRows) {
    if (!byDay.has(r.day)) byDay.set(r.day, []);
    byDay.get(r.day)!.push({ userId: r.userId, seconds: r.seconds });
  }

  // Earliest voice join per (day, user) — for the "logged in after 2 PM IST"
  // list. sessionRows is ordered ascending, so the first seen wins.
  const firstJoin = new Map<string, Map<string, Date>>(); // day -> userId -> Date
  for (const s of sessionRows) {
    const day = dayKey(s.joinedAt);
    if (!firstJoin.has(day)) firstJoin.set(day, new Map());
    const m = firstJoin.get(day)!;
    if (!m.has(s.userId)) m.set(s.userId, s.joinedAt);
  }
  const utcSecondsOfDay = (d: Date) =>
    d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
  const toIstHHMM = (d: Date) => {
    const ist = new Date(d.getTime() + 5.5 * 3600_000);
    return `${String(ist.getUTCHours()).padStart(2, "0")}:${String(
      ist.getUTCMinutes()
    ).padStart(2, "0")}`;
  };

  // Per-day buckets, oldest → newest, weekdays flagged (rules: Mon–Fri working).
  const days: {
    date: string;
    weekday: boolean;
    met: { id: string; s: number }[];
    under: { id: string; s: number }[];
    leave: string[];
    absent: string[];
    lateLogin: { id: string; join: string }[]; // present but joined after 2 PM IST
    noShowByCutoff: string[]; // roster members with no join at all by 2 PM IST
  }[] = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400_000);
    const date = dayKey(d);
    const dow = d.getUTCDay();
    const weekday = dow >= 1 && dow <= 5;
    const rows = (byDay.get(date) ?? []).filter((r) => r.seconds > 0);
    const met = rows.filter((r) => r.seconds >= THRESHOLD_SECONDS);
    const under = rows.filter((r) => r.seconds < THRESHOLD_SECONDS);
    const presentIds = new Set(rows.map((r) => r.userId));
    const onLeave = [...(leaveDays.get(date) ?? [])].filter(
      (id) => rosterIds.has(id) && !presentIds.has(id)
    );
    const leaveSet = new Set(onLeave);
    const absent = roster
      .filter((m) => !presentIds.has(m.id) && !leaveSet.has(m.id))
      .map((m) => m.id);

    // Login-punctuality against the 2 PM IST cutoff.
    const joins = firstJoin.get(date);
    const lateLogin: { id: string; join: string }[] = [];
    for (const r of rows) {
      const jt = joins?.get(r.userId);
      if (jt && utcSecondsOfDay(jt) > LOGIN_CUTOFF_UTC_SECONDS)
        lateLogin.push({ id: r.userId, join: toIstHHMM(jt) });
    }
    lateLogin.sort((a, b) => a.join.localeCompare(b.join));
    // Roster members who had NOT joined voice by the cutoff = late logins +
    // absentees (excluding approved leave). This is "not logged in till 2 PM".
    const noShowByCutoff = roster
      .filter((m) => {
        if (leaveSet.has(m.id)) return false;
        const jt = joins?.get(m.id);
        return !jt || utcSecondsOfDay(jt) > LOGIN_CUTOFF_UTC_SECONDS;
      })
      .map((m) => m.id);

    days.push({
      date,
      weekday,
      met: met.map((r) => ({ id: r.userId, s: r.seconds })),
      under: under.map((r) => ({ id: r.userId, s: r.seconds })),
      leave: onLeave,
      absent,
      lateLogin,
      noShowByCutoff,
    });
  }

  // Meetings with absentee / late / excused name lists.
  const meetingsOut = meetings.map((m) => {
    const att = m.attendance;
    const pick = (status: string) =>
      att
        .filter((a) => a.status === status)
        .map((a) => ({
          name: a.fullName ?? nameById.get(a.userId) ?? a.userId,
          project: a.project,
          late: a.minutesLate,
        }));
    return {
      id: m.id,
      title: m.title,
      startAt: m.startAt.toISOString(),
      status: m.status,
      audience: [
        m.audienceType,
        m.audienceProject,
        m.audienceModule ? `M${m.audienceModule}` : null,
        m.audiencePod ? `P${m.audiencePod}` : null,
        m.audienceBatch,
      ]
        .filter(Boolean)
        .join(" · "),
      present: att.filter((a) => a.status === "present").length,
      late: pick("late"),
      absent: pick("absent"),
      excused: pick("excused"),
      total: att.length,
    };
  });

  // Per-member 30d rollup for the Members dashboard.
  const perMember = roster.map((m) => {
    let total = 0;
    let daysPresent = 0;
    let daysMet = 0;
    for (const d of days) {
      const hit = [...d.met, ...d.under].find((r) => r.id === m.id);
      if (hit) {
        total += hit.s;
        daysPresent++;
        if (hit.s >= THRESHOLD_SECONDS) daysMet++;
      }
    }
    return {
      id: m.id,
      name: m.name,
      batch: m.batch,
      project: m.project,
      module: m.module,
      pod: m.pod,
      totalSeconds: total,
      daysPresent,
      daysMet,
    };
  });

  // Meeting attendance % per member (from raw records — more reliable).
  const meetStats = new Map<string, { total: number; ok: number }>();
  for (const m of meetings)
    for (const a of m.attendance) {
      const s = meetStats.get(a.userId) ?? { total: 0, ok: 0 };
      s.total++;
      if (a.status === "present" || a.status === "late") s.ok++;
      meetStats.set(a.userId, s);
    }
  const perMemberOut = perMember.map((m) => {
    const s = meetStats.get(m.id);
    return {
      ...m,
      meetings: s?.total ?? 0,
      meetingPct: s && s.total > 0 ? Math.round((s.ok / s.total) * 100) : null,
    };
  });

  const data = {
    generatedAt: now.toISOString(),
    windowDays: WINDOW_DAYS,
    thresholdSeconds: THRESHOLD_SECONDS,
    orgName: "Intern Org",
    projects: org.projects.filter((p) => p.active).map((p) => p.name),
    members: Object.fromEntries(nameById),
    roster,
    days,
    meetings: meetingsOut,
    perMember: perMemberOut,
    leaves: leaves.map((l) => ({
      name: nameById.get(l.userId) ?? l.userId,
      type: l.type,
      status: l.status,
      start: l.startAt.toISOString().slice(0, 10),
      end: l.endAt.toISOString().slice(0, 10),
      reason: l.reason,
    })),
    warns: warns.map((w) => ({
      name: nameById.get(w.userId) ?? w.userId,
      reason: w.reason,
      at: w.createdAt.toISOString().slice(0, 10),
    })),
    tickets: { open: ticketOpen, claimed: ticketClaimed },
  };

  const template = readFileSync(templatePath, "utf-8");
  const html = template.replace(
    "/*__DATA__*/",
    `window.DATA = ${JSON.stringify(data)};`
  );
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, "index.html");
  writeFileSync(outFile, html, "utf-8");
  console.log(
    `Dashboard written: ${outFile}\n` +
      `  roster=${roster.length} days=${days.length} meetings=${meetingsOut.length} ` +
      `leaves=${data.leaves.length} warns=${data.warns.length}`
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("export-dashboard failed:", err);
  process.exit(1);
});
