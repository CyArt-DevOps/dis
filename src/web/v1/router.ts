import express from "express";
import { ChannelType, type GuildBasedChannel } from "discord.js";
import { env } from "../../config/env.js";
import { org } from "../../config/loader.js";
import { prisma } from "../../core/db.js";
import { botGuild } from "../../core/botClient.js";
import { apiKeyGuard } from "./apiKey.js";
import { membersReady } from "../../services/memberCache.js";
import { leadershipFromRoleNames, memberDto, orgDto, projectKeyOf } from "../../services/integrationPayloads.js";
import { shiftDayKey, tzDayStartUtc } from "../../lib/time.js";
import { assignedChannelIds, indexChannels, voiceDay, type ChannelLite } from "../../services/assignedVoice.js";
import { meetingsRouter } from "./meetings.js";
import { ladderRouter } from "./ladder.js";

/**
 * Read API for the EMS portal. Bearer DIS_API_KEY; no cookie. Mounted ahead of
 * the dashboard password gate in server.ts.
 */
export const v1Router = express.Router();
v1Router.use(apiKeyGuard(() => env.DIS_API_KEY));

const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
/** When this process started: EMS treats a restart during a day as possible voice-data loss (Phase 4 §3.3). */
const STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();

// Meetings synced with EMS (Phase 3): create / edit / cancel / catch-up / attendance.
v1Router.use("/meetings", meetingsRouter);
// Strictness ladder (Phase 4): /dm, /settings/auto-warn, /warns.
v1Router.use(ladderRouter);

v1Router.get("/health", (_req, res) => {
  res.json({ ok: true, botOnline: botGuild(env.DISCORD_GUILD_ID) !== null, now: new Date().toISOString(), startedAt: STARTED_AT });
});

/** All members (or those changed since `?updatedSince=ISO`), with leadership from live roles. */
v1Router.get("/members", async (req, res) => {
  const since = typeof req.query.updatedSince === "string" ? new Date(req.query.updatedSince) : null;
  if (since && Number.isNaN(since.getTime())) {
    res.status(400).json({ error: "updatedSince must be an ISO date" });
    return;
  }
  // Leadership is derived from live roles; without the guild we'd report every
  // lead as a non-lead and EMS would demote them. Fail loudly instead.
  const guild = botGuild(env.DISCORD_GUILD_ID);
  if (!guild) {
    res.status(503).json({ error: "bot offline — leadership unknown" });
    return;
  }
  if (!membersReady()) {
    res.status(503).json({ error: "member cache warming" });
    return;
  }
  const rows = await prisma.member.findMany({
    where: {
      guildId: env.DISCORD_GUILD_ID,
      ...(since ? { updatedAt: { gt: since } } : {}),
    },
    orderBy: { updatedAt: "asc" },
  });
  res.json(
    rows.map((m) => {
      const names = guild.members.cache.get(m.id)?.roles.cache.map((r) => r.name) ?? [];
      // Module/pod only mean something under a project EMS knows; drop them with it.
      const project = projectKeyOf(m.project, org.projects);
      return memberDto(
        { ...m, project, module: project ? m.module : null, pod: project ? m.pod : null },
        leadershipFromRoleNames(names, org.projects)
      );
    })
  );
});

v1Router.get("/org", (_req, res) => {
  res.json(orgDto(org.projects));
});

function toLite(c: GuildBasedChannel): ChannelLite {
  const kind = c.type === ChannelType.GuildVoice ? "voice" : c.type === ChannelType.GuildCategory ? "category" : "other";
  return { id: c.id, name: c.name, kind, parentId: c.parentId ?? null };
}

/**
 * Adds secondsAssigned / firstJoinAt to Attendance rows (Phase 2 §8). Sessions
 * overlapping the requested IST days are clipped per day; assigned channels come
 * from the live guild (names + parent category, as bootstrap creates them) and
 * are resolved once per request.
 */
async function withVoiceDetail(rows: { userId: string; day: string; seconds: number }[]) {
  if (rows.length === 0) return [];
  const days = [...new Set(rows.map((r) => r.day))].sort();
  const rangeStart = tzDayStartUtc(days[0]!);
  const rangeEnd = tzDayStartUtc(shiftDayKey(days[days.length - 1]!, 1));
  const userIds = [...new Set(rows.map((r) => r.userId))];
  const sessions = await prisma.voiceSession.findMany({
    where: {
      guildId: env.DISCORD_GUILD_ID,
      userId: { in: userIds },
      joinedAt: { lt: rangeEnd },
      OR: [{ leftAt: null }, { leftAt: { gt: rangeStart } }],
    },
    select: { userId: true, channelId: true, joinedAt: true, leftAt: true },
  });
  const byUser = new Map<string, typeof sessions>();
  for (const s of sessions) {
    const list = byUser.get(s.userId) ?? [];
    list.push(s);
    byUser.set(s.userId, list);
  }

  // Guild unavailable OR member roles not warmed yet (empty role cache would make
  // leads look like plain members) → assigned channels unknown → null, never a guess.
  const guild = membersReady() ? botGuild(env.DISCORD_GUILD_ID) : null;
  const assigned = new Map<string, Set<string>>();
  if (guild) {
    const index = indexChannels(Array.from(guild.channels.cache.values(), toLite));
    const members = await prisma.member.findMany({
      where: { guildId: env.DISCORD_GUILD_ID, id: { in: userIds } },
      select: { id: true, project: true, module: true, pod: true },
    });
    for (const m of members) {
      const names = guild.members.cache.get(m.id)?.roles.cache.map((r) => r.name) ?? [];
      const lead = leadershipFromRoleNames(names, org.projects);
      assigned.set(m.id, assignedChannelIds(index, org.projects, {
        project: m.project, module: m.module, pod: m.pod, leadOf: [...lead.teamLeadOf, ...lead.coLeadOf],
      }));
    }
  }

  const now = new Date();
  return rows.map((r) => {
    const v = voiceDay(
      byUser.get(r.userId) ?? [],
      tzDayStartUtc(r.day),
      tzDayStartUtc(shiftDayKey(r.day, 1)),
      now,
      guild ? assigned.get(r.userId) ?? new Set<string>() : null
    );
    return { userId: r.userId, day: r.day, seconds: r.seconds, secondsAssigned: v.secondsAssigned === null ? null : Math.min(v.secondsAssigned, r.seconds), firstJoinAt: v.firstJoinAt ? v.firstJoinAt.toISOString() : null };
  });
}

/** Voice per member per day, ?from&to (max 31 days): seconds total, seconds in assigned VCs, first join. */
v1Router.get("/attendance", async (req, res) => {
  const { from, to } = req.query;
  if (!isDay(from) || !isDay(to) || from > to) {
    res.status(400).json({ error: "from and to (YYYY-MM-DD) required" });
    return;
  }
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000;
  if (Number.isNaN(span)) {
    res.status(400).json({ error: "from and to must be real calendar dates" });
    return;
  }
  if (span > 30) {
    res.status(400).json({ error: "range too large (max 31 days)" });
    return;
  }
  const rows = await prisma.attendance.findMany({
    where: { guildId: env.DISCORD_GUILD_ID, day: { gte: from, lte: to } },
    select: { userId: true, day: true, seconds: true },
  });
  res.json(await withVoiceDetail(rows));
});
