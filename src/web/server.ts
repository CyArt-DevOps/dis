import express from "express";
import { authRoutes } from "./auth.js";
import { legalRoutes } from "./legal.js";
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
import { memberInsights, orgInsights } from "../services/insights.js";
import { LeaveInputError, grantManualLeave, revokeManualLeave } from "../services/manualLeave.js";
import { HolidayInputError, addHoliday, listHolidays, removeHoliday } from "../services/holidays.js";
import {
  WarningError,
  createManualWarning,
  addWarningNote,
  dismissWarning,
  memberWarnings,
  revokeWarning,
  listTerminations,
  listWarnings,
  runHoursSweep,
  sendAllProposed,
  sendWarning,
  terminateMember,
  terminationCandidates,
} from "../services/warnings.js";
import { clearCalendarCache } from "../services/calendar.js";
import { buildMemberReport, reportPeriod, trackedFromOf } from "../services/reportPdf.js";
import { HrAuthError, activeHrNames, changeOwnPassword, hrName, requireHr, verifyHr } from "../services/hrUsers.js";
import { clearInsightsCache } from "../services/insights.js";
import { prisma } from "../core/db.js";
import { shiftDayKey, tzDateKey, tzName } from "../lib/time.js";
import { dashboardHtml } from "./page.js";
import { v1Router } from "./v1/router.js";
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
// Terms of Service and Privacy Policy are public (Discord app verification needs
// them); everything else stays behind the password gate below.
app.use(legalRoutes);
// EMS machine API: its own Bearer key, so it sits ahead of the staff password gate.
app.use("/api/v1", v1Router);
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
  const profile = await memberProfile(guildOf(req), req.params.id, from, to);
  const insights = profile.member
    ? await memberInsights(guildOf(req), req.params.id, profile.calendar, from, to)
    : null;
  res.json({ ...profile, insights });
});

/**
 * Writes are few and staff-only. Beyond the session cookie (SameSite=Lax, so
 * no cross-site POSTs carry it), require JSON and a same-origin Origin header:
 * a form on another site can send neither.
 */
const sameOrigin: express.RequestHandler = (req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) {
        res.status(403).json({ error: "cross-origin request refused" });
        return;
      }
    } catch {
      res.status(403).json({ error: "bad origin" });
      return;
    }
  }
  if (!req.is("application/json")) {
    res.status(415).json({ error: "JSON body required" });
    return;
  }
  next();
};

/** HR grants approved leave for specific days from the profile page. */
app.post("/api/profile/:id/leave", express.json({ limit: "8kb" }), sameOrigin, requireHr, async (req, res) => {
  try {
    const out = await grantManualLeave(guildOf(req), String(req.params.id), { ...(req.body ?? {}), approvedBy: hrName(req) });
    logger.info({ userId: req.params.id, leave: out.id, days: out.days, hr: hrName(req) }, "Leave granted from dashboard");
    res.json(out);
  } catch (err) {
    if (err instanceof LeaveInputError) res.status(400).json({ error: err.message });
    else throw err;
  }
});

app.post("/api/profile/:id/leave/:leaveId/revoke", express.json({ limit: "1kb" }), sameOrigin, requireHr, async (req, res) => {
  try {
    await revokeManualLeave(guildOf(req), String(req.params.id), Number(req.params.leaveId));
    logger.info({ userId: req.params.id, leave: req.params.leaveId, hr: hrName(req) }, "Dashboard leave revoked");
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof LeaveInputError) res.status(400).json({ error: err.message });
    else throw err;
  }
});

/** Run an async write handler; known input errors become 400s. */
function action(fn: (req: express.Request) => Promise<unknown>): express.RequestHandler {
  return async (req, res) => {
    try {
      res.json((await fn(req)) ?? { ok: true });
    } catch (err) {
      if (err instanceof WarningError || err instanceof HolidayInputError) {
        res.status(400).json({ error: err.message });
      } else if (err instanceof HrAuthError) {
        res.status(err.status).json({ error: err.message, hrAuth: err.status === 401 });
      } else throw err;
    }
  };
}
const jsonBody = express.json({ limit: "8kb" });

// ----- HR sign-off: names to pick from, and password verification
app.get("/api/hr/names", async (_req, res) => {
  res.json(await activeHrNames());
});
app.post(
  "/api/hr/verify",
  jsonBody,
  sameOrigin,
  action(async (req) => {
    const b = (req.body ?? {}) as { name?: unknown; password?: unknown };
    // Behind Cloudflare the client IP is in CF-Connecting-IP; fall back to the socket.
    const ip = String(req.headers["cf-connecting-ip"] ?? req.ip ?? "unknown");
    return verifyHr(String(b.name ?? ""), String(b.password ?? ""), ip);
  })
);
/** An HR member changes their own password (needs the current one). */
app.post(
  "/api/hr/password",
  jsonBody,
  sameOrigin,
  action(async (req) => {
    const b = (req.body ?? {}) as { name?: unknown; current?: unknown; next?: unknown };
    const ip = String(req.headers["cf-connecting-ip"] ?? req.ip ?? "unknown");
    await changeOwnPassword(String(b.name ?? ""), String(b.current ?? ""), String(b.next ?? ""), ip);
  })
);

// ----- Public holidays
app.get("/api/holidays", async (req, res) => {
  res.json(await listHolidays(guildOf(req)));
});
app.post(
  "/api/holidays",
  jsonBody,
  sameOrigin,
  requireHr,
  action(async (req) => {
    const row = await addHoliday(guildOf(req), { ...(req.body ?? {}), addedBy: hrName(req) });
    clearCalendarCache();
    clearInsightsCache();
    logger.info({ day: row.day, name: row.name, hr: hrName(req) }, "Holiday added from dashboard");
    return row;
  })
);
app.post(
  "/api/holidays/:id/delete",
  jsonBody,
  sameOrigin,
  requireHr,
  action(async (req) => {
    await removeHoliday(guildOf(req), Number(req.params.id));
    clearCalendarCache();
    clearInsightsCache();
  })
);

// ----- Warnings
app.get("/api/warnings", async (req, res) => {
  const [data, candidates, terminations] = await Promise.all([
    listWarnings(guildOf(req)),
    terminationCandidates(guildOf(req)),
    listTerminations(guildOf(req)),
  ]);
  res.json({ ...data, candidates, terminations });
});
app.post(
  "/api/warnings",
  jsonBody,
  sameOrigin,
  requireHr,
  action((req) => createManualWarning(guildOf(req), { ...(req.body ?? {}), issuedBy: hrName(req) }))
);
app.post(
  "/api/warnings/:id/send",
  jsonBody,
  sameOrigin,
  requireHr,
  action((req) => sendWarning(Number(req.params.id), hrName(req)))
);
app.post(
  "/api/warnings/:id/dismiss",
  jsonBody,
  sameOrigin,
  requireHr,
  action((req) => dismissWarning(Number(req.params.id), guildOf(req), hrName(req)))
);
app.post(
  "/api/warnings/:id/revoke",
  jsonBody,
  sameOrigin,
  requireHr,
  action((req) => revokeWarning(Number(req.params.id), guildOf(req), hrName(req), (req.body as { reason?: unknown })?.reason))
);
app.post(
  "/api/warnings/:id/notes",
  jsonBody,
  sameOrigin,
  requireHr,
  action((req) => addWarningNote(Number(req.params.id), guildOf(req), hrName(req), req.body ?? {}))
);
/** Official PDF report on the letterhead, signed off by the verified HR member. */
app.post("/api/profile/:id/report", jsonBody, sameOrigin, requireHr, async (req, res) => {
  const userId = String(req.params.id);
  const b = (req.body ?? {}) as { period?: unknown; month?: unknown };
  const kind = b.period === "full" ? "full" : "month";
  const period = reportPeriod(kind, typeof b.month === "string" ? b.month : undefined, kind === "full" ? await trackedFromOf(guildOf(req), userId) : null);
  try {
    const { pdf, filename } = await buildMemberReport(guildOf(req), userId, period, hrName(req));
    logger.info({ userId, period, hr: hrName(req) }, "Member report generated");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(pdf);
  } catch (err) {
    if ((err as Error).message === "Member not found.") res.status(404).json({ error: "Member not found." });
    else throw err;
  }
});

/** Everything on record for one member: warnings, strikes, HR notes. */
app.get("/api/profile/:id/warnings", async (req, res) => {
  res.json(await memberWarnings(guildOf(req), req.params.id));
});
app.post(
  "/api/warnings/send-all",
  jsonBody,
  sameOrigin,
  requireHr,
  action((req) => sendAllProposed(guildOf(req), hrName(req)))
);
app.post("/api/warnings/run-check", jsonBody, sameOrigin, requireHr, action((req) => runHoursSweep(guildOf(req))));
app.post(
  "/api/members/:id/terminate",
  jsonBody,
  sameOrigin,
  requireHr,
  action(async (req) => {
    const by = hrName(req);
    if ((req.body as { confirm?: unknown })?.confirm !== "TERMINATE") {
      throw new WarningError('Type TERMINATE to confirm.');
    }
    return terminateMember(guildOf(req), String(req.params.id), `dashboard:${by}`);
  })
);

/** Member picker for the manual warning form. */
app.get("/api/members/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) {
    res.json([]);
    return;
  }
  const rows = await prisma.member.findMany({
    where: {
      guildId: guildOf(req),
      OR: [{ fullName: { contains: q } }, { displayName: { contains: q } }, { tag: { contains: q } }, { id: q }],
    },
    select: { id: true, fullName: true, displayName: true, tag: true, project: true, batch: true },
    take: 12,
  });
  res.json(rows.map((m) => ({ ...m, fullName: m.fullName ?? m.displayName ?? m.tag ?? m.id })));
});

/** One meeting with everyone expected: who joined, when, who was late. */
app.get("/api/meetings/:id", async (req, res) => {
  const id = Number(req.params.id);
  const meeting = Number.isInteger(id)
    ? await prisma.meeting.findFirst({ where: { id, guildId: guildOf(req) } })
    : null;
  if (!meeting) {
    res.status(404).json({ error: "Meeting not found" });
    return;
  }
  const [rows, organizer] = await Promise.all([
    prisma.meetingAttendance.findMany({
      where: { meetingId: id },
      orderBy: [{ actualJoinAt: "asc" }],
      select: {
        userId: true,
        fullName: true,
        batch: true,
        project: true,
        module: true,
        pod: true,
        status: true,
        actualJoinAt: true,
        minutesLate: true,
        leaveStatus: true,
      },
    }),
    prisma.member.findUnique({
      where: { id: meeting.organizerId },
      select: { fullName: true, displayName: true, tag: true },
    }),
  ]);
  res.json({
    meeting: {
      ...meeting,
      organizerName: organizer?.fullName ?? organizer?.displayName ?? organizer?.tag ?? meeting.organizerId,
    },
    attendees: rows,
  });
});

/** Org analytics for the Overview: compliance, violations, projects, people. */
app.get("/api/insights", async (req, res) => {
  const range = rangeOf(req);
  res.json(await orgInsights(range.guildId, range.from, range.to));
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
 * Start the dashboard (loopback unless WEB_HOST is set — see the note at the
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
