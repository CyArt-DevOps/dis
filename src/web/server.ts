import express from "express";
import { authRoutes } from "./auth.js";
import { env } from "../config/env.js";
import { logger } from "../core/logger.js";
import { computeAttendance, computeByMember, type AttendanceFilter } from "../services/attendanceStats.js";
import {
  complianceForDay,
  defaultRange,
  liveVoice,
  pendingByUser,
  voiceByDay,
  voiceByMember,
  voiceOverview,
  type VoiceRange,
} from "../services/voiceStats.js";
import {
  cachedCompactCalendars,
  eachDay,
  filterOptions,
  memberProfile,
  type MemberScope,
} from "../services/calendar.js";
import { prisma } from "../core/db.js";
import { shiftDayKey, tzDateKey, tzName } from "../lib/time.js";
import { dashboardHtml } from "./page.js";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read-only attendance dashboard. Mounted inside the bot process (see
 * startDashboard, called on ClientReady) so `npm start` serves it too;
 * `npm run web` runs the same app standalone.
 *
 * Access: with WEB_PASSWORD unset the listeners bind loopback only and there is
 * no gate — the local development setup, unchanged. Setting WEB_HOST to a
 * routable address (hosting) REQUIRES WEB_PASSWORD, and startDashboard refuses
 * to bind without it: this data (member names, attendance, leave) must never be
 * served open to the internet.
 */
const LOOPBACK_HOSTS = ["127.0.0.1", "::1"];

const app = express();

// Only the login form needs a body parser; the rest of the app is read-only.
app.use(express.urlencoded({ extended: false }));
for (const h of authRoutes()) app.use(h);

function guildOf(req: express.Request): string {
  return String(req.query.guild ?? env.DISCORD_GUILD_ID);
}

/** `?days=N` (0 = all time), or explicit `?from=YYYY-MM-DD&to=YYYY-MM-DD`. */
function rangeOf(req: express.Request): VoiceRange {
  const guildId = guildOf(req);
  const requested = Number(req.query.days ?? 7);
  if (requested === 0) {
    return { guildId, from: "1970-01-01", to: tzDateKey(new Date()) };
  }
  const days = Math.min(365, Math.max(1, requested || 7));
  const base = defaultRange(guildId, days);
  const isDay = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const from = isDay(req.query.from) ? String(req.query.from) : base.from;
  const to = isDay(req.query.to) ? String(req.query.to) : base.to;
  return from <= to ? { guildId, from, to } : { guildId, from: to, to: from };
}

/** Meeting-attendance filters shared by /api/leaderboard and /api/summary. */
function meetingFilterOf(req: express.Request): AttendanceFilter {
  const f: AttendanceFilter = { guildId: guildOf(req) };
  const str = (k: string) => (req.query[k] ? String(req.query[k]) : undefined);
  const int = (k: string) => (req.query[k] ? Number(req.query[k]) : undefined);
  f.batch = str("batch");
  f.project = str("project");
  f.module = Number.isInteger(int("module")) ? int("module") : undefined;
  f.pod = Number.isInteger(int("pod")) ? int("pod") : undefined;
  const r = rangeOf(req);
  // days=0 means all time — leave the meeting window unbounded.
  if (Number(req.query.days) !== 0 && (req.query.from || req.query.to || req.query.days)) {
    f.from = new Date(`${r.from}T00:00:00Z`);
    f.to = new Date(`${r.to}T23:59:59Z`);
  }
  return f;
}

app.get("/api/config", (req, res) => {
  res.json({ guildId: guildOf(req), timezone: tzName(), today: tzDateKey(new Date()) });
});

app.get("/api/overview", async (req, res) => {
  const range = rangeOf(req);
  const [voice, meetings] = await Promise.all([
    voiceOverview(range),
    computeAttendance(meetingFilterOf(req)),
  ]);
  res.json({ voice, meetings });
});

app.get("/api/leaderboard", async (req, res) => {
  const min = Math.max(1, Number(req.query.min_meetings ?? 1) || 1);
  const rows = (await computeByMember(meetingFilterOf(req)))
    .filter((m) => m.total >= min)
    .sort((a, b) => b.pct - a.pct || b.total - a.total);
  res.json(rows);
});

app.get("/api/voice", async (req, res) => {
  const range = rangeOf(req);
  const [members, days] = await Promise.all([voiceByMember(range), voiceByDay(range)]);
  res.json({ range, members, days });
});

app.get("/api/live", async (req, res) => {
  res.json(await liveVoice(guildOf(req)));
});

/** Values for the filter dropdowns, plus the attendance policy. */
app.get("/api/filters", async (req, res) => {
  res.json(await filterOptions(guildOf(req)));
});

function scopeOf(req: express.Request): MemberScope {
  const str = (k: string) => (req.query[k] ? String(req.query[k]) : undefined);
  const int = (k: string) => {
    const v = Number(req.query[k]);
    return req.query[k] !== undefined && Number.isInteger(v) ? v : undefined;
  };
  return {
    batch: str("batch"),
    project: str("project"),
    module: int("module"),
    pod: int("pod"),
    q: str("q"),
  };
}

/** Calendar range: `?from&to`, or `?month=YYYY-MM`, defaulting to this month. */
function calendarRange(req: express.Request): { from: string; to: string } {
  const isDay = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (isDay(req.query.from) && isDay(req.query.to)) {
    return { from: String(req.query.from), to: String(req.query.to) };
  }
  const month =
    typeof req.query.month === "string" && /^\d{4}-\d{2}$/.test(req.query.month)
      ? req.query.month
      : tzDateKey(new Date()).slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate(); // day 0 of next month
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/** Group calendar: members in scope × days, for the calendar views. */
app.get("/api/calendar", async (req, res) => {
  const { from, to } = calendarRange(req);
  const members = await cachedCompactCalendars(guildOf(req), scopeOf(req), from, to);
  res.json({ from, to, days: eachDay(from, to), members });
});

/** Full profile for one member: calendar, meetings, leave history. */
app.get("/api/profile/:id", async (req, res) => {
  const { from, to } = calendarRange(req);
  res.json(await memberProfile(guildOf(req), req.params.id, from, to));
});

/** Rule compliance for one local day (`?day=YYYY-MM-DD`, default today). */
app.get("/api/compliance", async (req, res) => {
  const day =
    typeof req.query.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day)
      ? req.query.day
      : tzDateKey(new Date());
  res.json(await complianceForDay(guildOf(req), day));
});

app.get("/api/meetings", async (req, res) => {
  const meetings = await prisma.meeting.findMany({
    where: { guildId: guildOf(req) },
    orderBy: { startAt: "desc" },
    take: 50,
  });
  const counts = await prisma.meetingAttendance.groupBy({
    by: ["meetingId", "status"],
    where: { meetingId: { in: meetings.map((m) => m.id) } },
    _count: { _all: true },
  });
  const byMeeting = new Map<number, Record<string, number>>();
  for (const c of counts) {
    const row = byMeeting.get(c.meetingId) ?? {};
    row[c.status] = c._count._all;
    byMeeting.set(c.meetingId, row);
  }
  res.json(
    meetings.map((m) => ({
      ...m,
      counts: byMeeting.get(m.id) ?? {},
    }))
  );
});

/** Per-day voice detail for one member (used by the drill-down row). */
app.get("/api/member/:id", async (req, res) => {
  const range = rangeOf(req);
  const userId = req.params.id;
  const [rows, member, meetings, pending] = await Promise.all([
    prisma.attendance.findMany({
      where: { guildId: range.guildId, userId, day: { gte: range.from, lte: range.to } },
      orderBy: { day: "asc" },
    }),
    prisma.member.findUnique({ where: { id: userId } }),
    prisma.meetingAttendance.findMany({
      where: { userId, meeting: { guildId: range.guildId } },
      orderBy: { scheduledStart: "desc" },
      take: 25,
      select: {
        status: true,
        minutesLate: true,
        scheduledStart: true,
        meeting: { select: { id: true, title: true } },
      },
    }),
    pendingByUser(range.guildId, userId),
  ]);
  const days: { day: string; seconds: number }[] = [];
  const byDay = new Map(rows.map((r) => [r.day, r.seconds]));
  // Include the live tail so today's row matches the totals shown elsewhere.
  for (const [day, secs] of pending.get(userId) ?? new Map<string, number>()) {
    byDay.set(day, (byDay.get(day) ?? 0) + secs);
  }
  for (let day = range.from; day <= range.to; day = shiftDayKey(day, 1)) {
    days.push({ day, seconds: byDay.get(day) ?? 0 });
  }
  res.json({ member, days, meetings });
});

/**
 * The HeroUI single-page app, built by `npm run build:ui` into webui/dist.
 * Anchored to this module (src/web or dist/web → up two → root) so it resolves
 * the same under tsx and from dist, whatever the cwd. If it hasn't been built,
 * fall back to the legacy self-contained page rather than serving a 404.
 */
const uiDist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "webui", "dist");
const uiIndex = join(uiDist, "index.html");
const uiBuilt = existsSync(uiIndex);

if (uiBuilt) {
  app.use(express.static(uiDist, { index: false, maxAge: "1h" }));
}

app.get("/legacy", (_req, res) => {
  res.type("html").send(dashboardHtml());
});

// SPA fallback: any non-/api path renders the app so deep links work on reload.
app.get(/^(?!\/api\/).*/, (_req, res) => {
  if (uiBuilt) res.sendFile(uiIndex);
  else res.type("html").send(dashboardHtml());
});

export { app as dashboardApp };

type Server = import("node:http").Server;

let servers: Server[] = [];

/**
 * Bind one loopback address, resolving to the server or to the failure reason.
 * Never rejects — a missing IPv6 stack is normal and must not take the bot down.
 */
function listenOn(host: string, port: number): Promise<Server | string> {
  return new Promise((resolve) => {
    const s = app.listen({ host, port });
    const onListening = () => {
      s.removeListener("error", onError);
      resolve(s);
    };
    const onError = (err: NodeJS.ErrnoException) => {
      s.removeListener("listening", onListening);
      // The socket may already be half-open; make sure it can't linger.
      s.close(() => {});
      resolve(err.code ?? err.message);
    };
    s.once("listening", onListening);
    s.once("error", onError);
  });
}

/**
 * Start the dashboard on loopback only (there is no auth — see the note at the
 * top of this file).
 *
 * Both 127.0.0.1 AND ::1 are bound: browsers on Windows resolve "localhost" to
 * the IPv6 address first, so an IPv4-only listener answers curl but hands the
 * user ERR_CONNECTION_REFUSED. Binding a single address is the bug, not the fix.
 */
export async function startDashboard(): Promise<void> {
  if (servers.length > 0) return;
  const port = env.WEB_PORT;
  const exposed = env.WEB_HOST !== undefined;

  // Fail closed. A typo'd or forgotten WEB_PASSWORD on a public bind would put
  // every member's attendance history on the open internet, so refuse to serve
  // rather than serve it unguarded.
  if (exposed && !env.WEB_PASSWORD) {
    logger.error(
      { host: env.WEB_HOST, port },
      "Dashboard NOT started — WEB_HOST is set for public binding but WEB_PASSWORD is missing"
    );
    return;
  }

  const hosts = exposed ? [env.WEB_HOST as string] : LOOPBACK_HOSTS;
  const results = await Promise.all(
    hosts.map(async (host) => ({ host, result: await listenOn(host, port) }))
  );

  const ok = results.filter((r) => typeof r.result !== "string");
  const bad = results.filter((r) => typeof r.result === "string");
  servers = ok.map((r) => r.result as Server);

  if (servers.length === 0) {
    const inUse = bad.some((r) => r.result === "EADDRINUSE");
    logger.error(
      { port, failures: bad.map((r) => `${r.host}: ${r.result as string}`) },
      inUse
        ? "Dashboard NOT started — port already in use. Another bot instance or `npm run web` is probably running."
        : "Dashboard NOT started"
    );
    return;
  }

  logger.info(
    {
      url: exposed ? `http://${env.WEB_HOST as string}:${port}` : `http://localhost:${port}`,
      addresses: ok.map((r) => r.host),
      authenticated: Boolean(env.WEB_PASSWORD),
    },
    "Attendance dashboard listening"
  );
  // Partial bind is worth knowing about: it's what makes the site reachable
  // from curl but not from the browser (or vice versa).
  for (const r of bad) {
    logger.warn({ port, host: r.host, reason: r.result }, "Dashboard could not bind one address");
  }
}

export function stopDashboard(): void {
  for (const s of servers) s.close();
  servers = [];
}
