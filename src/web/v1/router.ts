import express from "express";
import { env } from "../../config/env.js";
import { org } from "../../config/loader.js";
import { prisma } from "../../core/db.js";
import { botGuild } from "../../core/botClient.js";
import { apiKeyGuard } from "./apiKey.js";
import { leadershipFromRoleNames, memberDto, orgDto, projectKeyOf } from "../../services/integrationPayloads.js";

/**
 * Read API for the EMS portal. Bearer DIS_API_KEY; no cookie. Mounted ahead of
 * the dashboard password gate in server.ts.
 */
export const v1Router = express.Router();
v1Router.use(apiKeyGuard(() => env.DIS_API_KEY));

const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

v1Router.get("/health", (_req, res) => {
  res.json({ ok: true, botOnline: botGuild(env.DISCORD_GUILD_ID) !== null, now: new Date().toISOString() });
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

/** Voice seconds per member per day, `?from&to` (max 31 days). */
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
  if (span > 31) {
    res.status(400).json({ error: "range too large (max 31 days)" });
    return;
  }
  const rows = await prisma.attendance.findMany({
    where: { guildId: env.DISCORD_GUILD_ID, day: { gte: from, lte: to } },
    select: { userId: true, day: true, seconds: true },
  });
  res.json(rows);
});
