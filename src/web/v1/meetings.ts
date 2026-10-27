import express from "express";
import { ChannelType, type Guild, type GuildBasedChannel } from "discord.js";
import { z } from "zod";
import { env } from "../../config/env.js";
import { org } from "../../config/loader.js";
import { prisma } from "../../core/db.js";
import { logger } from "../../core/logger.js";
import { botGuild } from "../../core/botClient.js";
import { membersReady } from "../../services/memberCache.js";
import { getOfficeVoiceChannel } from "../../services/meeting.js";
import {
  cancelMeeting,
  renotifyMeeting,
  resolveAudienceRole,
  scheduleMeeting,
  type AudienceType,
  type ScheduleArgs,
} from "../../services/meetingScheduler.js";
import { indexChannels, meetingVoiceChannelId, type ChannelLite } from "../../services/assignedVoice.js";
import { attendanceRows, meetingDto } from "../../services/meetingSync.js";

/**
 * Meetings API for EMS (Phase 3 §3.3). Mounted under /api/v1/meetings, behind the
 * v1 Bearer guard. EMS is trusted to have checked permissions; the bot only checks
 * that the audience resolves to a real role / real members. Changes made here are
 * never echoed back to EMS as events (scheduleMeeting / cancelMeeting get source "ems").
 *
 * Errors: { error: <code>, message, issues? }.
 */
export const meetingsRouter = express.Router();
meetingsRouter.use(express.json({ limit: "64kb" }));

const AUDIENCES = ["org", "batch", "project", "module", "pod", "people"] as const;
const discordId = z.string().regex(/^\d{15,25}$/, "must be a Discord id");
const uidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "must be a UUID");
// An explicit offset (Z or ±hh:mm) is required: a bare local time would be read in
// the bot host's timezone and silently shift the meeting.
const isoDate = z
  .string()
  .datetime({ offset: true, message: "must be an ISO date with an offset (Z or ±hh:mm)" })
  .transform((v) => new Date(v));

const createSchema = z
  .object({
    uid: uidSchema,
    title: z.string().trim().min(1).max(200),
    description: z.string().max(2000).nullish(),
    organizerDiscordId: discordId.nullish(),
    startAt: isoDate,
    durationMin: z.number().int().min(5).max(600),
    audienceType: z.enum(AUDIENCES),
    audienceBatch: z.string().min(1).max(100).nullish(),
    audienceProject: z.string().min(1).max(64).nullish(),
    audienceModule: z.number().int().min(1).nullish(),
    audiencePod: z.number().int().min(1).nullish(),
    audienceMemberIds: z.array(discordId).min(1).max(100).nullish(),
    // people only: drop listed ids that are not in the server instead of a 422
    // (EMS's automatic ladder meetings, where a Team Lead may have left).
    allowMissingMembers: z.boolean().optional().default(false),
    mandatory: z.boolean(),
    office: z.enum(["manager", "hr"]).nullish(),
    recurrenceUid: uidSchema.nullish(),
    updatedAt: isoDate.nullish(),
  })
  .superRefine((b, ctx) => {
    const need = (ok: unknown, path: string) => {
      if (!ok) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: `required for audience ${b.audienceType}` });
    };
    if (b.audienceType === "batch") need(b.audienceBatch, "audienceBatch");
    if (["project", "module", "pod"].includes(b.audienceType)) need(b.audienceProject, "audienceProject");
    if (["module", "pod"].includes(b.audienceType)) need(b.audienceModule, "audienceModule");
    if (b.audienceType === "pod") need(b.audiencePod, "audiencePod");
    if (b.audienceType === "people") need(b.audienceMemberIds?.length, "audienceMemberIds");
  });

const patchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  startAt: isoDate.optional(),
  durationMin: z.number().int().min(5).max(600).optional(),
  mandatory: z.boolean().optional(),
  updatedAt: isoDate,
});

const cancelSchema = z.object({ updatedAt: isoDate.nullish() });

type Res = express.Response;
const fail = (res: Res, status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
  res.status(status).json({ error, message, ...extra });
const invalid = (res: Res, err: z.ZodError) =>
  fail(res, 400, "invalid", "Request body is invalid.", {
    issues: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`),
  });

function toLite(c: GuildBasedChannel): ChannelLite {
  const kind = c.type === ChannelType.GuildVoice ? "voice" : c.type === ChannelType.GuildCategory ? "category" : "other";
  return { id: c.id, name: c.name, kind, parentId: c.parentId ?? null };
}

/** Office VC for org / batch / people meetings; the project, module or pod VC otherwise. */
function voiceChannelFor(guild: Guild, a: {
  audienceType: string; audienceProject: string | null; audienceModule: number | null; audiencePod: number | null; office: "manager" | "hr";
}): string | null {
  if (a.audienceType === "org" || a.audienceType === "batch" || a.audienceType === "people") {
    return getOfficeVoiceChannel(guild, a.office)?.id ?? null;
  }
  const idx = indexChannels(Array.from(guild.channels.cache.values(), toLite));
  return meetingVoiceChannelId(idx, org.projects, a);
}

const isUniqueClash = (e: unknown) => (e as { code?: string })?.code === "P2002";

/**
 * Create. Same uid again → 200 with the stored meeting, never a duplicate.
 * people + allowMissingMembers: ids not in the server are dropped and echoed as
 * skippedMemberIds on the 201; if none remain it is still 422 audience_unresolved.
 */
meetingsRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) return invalid(res, parsed.error);
  const b = parsed.data;

  const existing = await prisma.meeting.findUnique({ where: { uid: b.uid } });
  if (existing) return res.status(200).json(meetingDto(existing));

  if (b.startAt.getTime() <= Date.now()) return fail(res, 422, "start_in_past", "startAt must be in the future.");
  const guild = botGuild(env.DISCORD_GUILD_ID);
  if (!guild) return fail(res, 503, "bot_offline", "The bot is offline; try again later.");

  const audience = {
    audienceType: b.audienceType as AudienceType,
    audienceBatch: b.audienceBatch ?? undefined,
    audienceProject: b.audienceProject ?? undefined,
    audienceModule: b.audienceModule ?? undefined,
    audiencePod: b.audiencePod ?? undefined,
  };
  let memberIds: string[] | undefined;
  let skippedMemberIds: string[] | undefined;
  if (b.audienceType === "people") {
    if (!membersReady()) return fail(res, 503, "member_cache_warming", "The bot is still loading members; try again shortly.");
    const listed = [...new Set(b.audienceMemberIds ?? [])];
    const missing = listed.filter((id) => !guild.members.cache.has(id));
    if (missing.length === listed.length) {
      return fail(res, 422, "audience_unresolved", "None of these people are in the Discord server.", { missing });
    }
    if (missing.length && !b.allowMissingMembers) {
      return fail(res, 422, "audience_unresolved", "Some people are not in the Discord server.", { missing });
    }
    memberIds = listed.filter((id) => guild.members.cache.has(id));
    if (b.allowMissingMembers) {
      skippedMemberIds = missing;
      if (missing.length) logger.info({ uid: b.uid, skipped: missing }, "v1 meeting: skipped people not in the server");
    }
  } else if (!resolveAudienceRole(guild, audience as ScheduleArgs)) {
    return fail(res, 422, "audience_unresolved", "No Discord role matches this audience.");
  }

  const office = b.office ?? "manager";
  const voiceChannelId = voiceChannelFor(guild, {
    audienceType: b.audienceType,
    audienceProject: b.audienceProject ?? null,
    audienceModule: b.audienceModule ?? null,
    audiencePod: b.audiencePod ?? null,
    office,
  });
  if (!voiceChannelId) return fail(res, 422, "voice_channel_missing", "The meeting's voice channel does not exist (run /setup).");

  try {
    const m = await scheduleMeeting({
      guild,
      organizerId: b.organizerDiscordId ?? guild.client.user?.id ?? "ems",
      title: b.title,
      description: b.description ?? undefined,
      startAt: b.startAt,
      durationMin: b.durationMin,
      ...audience,
      audienceMemberIds: memberIds?.join(","),
      office: b.audienceType === "people" ? office : undefined,
      voiceChannelId,
      mandatory: b.mandatory,
      attendanceWindowMin: 10,
      uid: b.uid,
      source: "ems",
      recurrenceUid: b.recurrenceUid ?? undefined,
      updatedAt: b.updatedAt ?? undefined,
    });
    return res.status(201).json(skippedMemberIds ? { ...meetingDto(m), skippedMemberIds } : meetingDto(m));
  } catch (err) {
    if (isUniqueClash(err)) {
      const again = await prisma.meeting.findUnique({ where: { uid: b.uid } });
      if (again) return res.status(200).json(meetingDto(again));
    }
    logger.error({ err, uid: b.uid }, "v1 meeting create failed");
    return fail(res, 500, "internal", "Could not create the meeting.");
  }
});

/**
 * Catch-up list for EMS: changed at or after ?updatedSince (max 500), ordered by
 * (updatedAt, uid). Paging: pass the last row's updatedAt as updatedSince and its
 * uid as afterId to get the rows strictly after that (updatedAt, uid) pair, so a
 * burst of more than 500 rows with the same updatedAt is never skipped or looped.
 * Without afterId the old behaviour (updatedAt >= updatedSince) is unchanged.
 */
meetingsRouter.get("/", async (req, res) => {
  const raw = req.query.updatedSince;
  const since = typeof raw === "string" ? new Date(raw) : new Date(0);
  if (Number.isNaN(since.getTime())) return fail(res, 400, "invalid", "updatedSince must be an ISO date.");
  const rawAfter = req.query.afterId;
  let afterId: string | undefined;
  if (rawAfter !== undefined) {
    const p = uidSchema.safeParse(rawAfter);
    if (!p.success) return fail(res, 400, "invalid", "afterId must be a meeting uid.");
    afterId = p.data;
  }
  const rows = await prisma.meeting.findMany({
    where: {
      guildId: env.DISCORD_GUILD_ID,
      ...(afterId
        ? { OR: [{ updatedAt: { gt: since } }, { updatedAt: since, uid: { gt: afterId } }] }
        : { updatedAt: { gte: since } }),
    },
    orderBy: [{ updatedAt: "asc" }, { uid: "asc" }],
    take: 500,
  });
  return res.json(rows.map(meetingDto));
});

/** Edit before start. Older updatedAt than stored → 409 stale. */
meetingsRouter.patch("/:uid", async (req, res) => {
  const parsed = patchSchema.safeParse(req.body ?? {});
  if (!parsed.success) return invalid(res, parsed.error);
  const b = parsed.data;
  const m = await prisma.meeting.findUnique({ where: { uid: req.params.uid } });
  if (!m) return fail(res, 404, "not_found", "No meeting with this uid.");
  if (m.status !== "scheduled") return fail(res, 409, "not_scheduled", `The meeting is ${m.status}.`, { meeting: meetingDto(m) });
  if (b.updatedAt.getTime() < m.updatedAt.getTime()) {
    return fail(res, 409, "stale", "The meeting changed after this edit was made.", { meeting: meetingDto(m) });
  }
  if (b.startAt && b.startAt.getTime() <= Date.now()) return fail(res, 422, "start_in_past", "startAt must be in the future.");

  const startChanged = b.startAt !== undefined && b.startAt.getTime() !== m.startAt.getTime();
  // Conditional on what was checked above: if the sweep started the meeting or
  // another edit landed in between, nothing is written and the caller gets a 409.
  const { count } = await prisma.meeting.updateMany({
    where: { id: m.id, status: "scheduled", updatedAt: m.updatedAt },
    data: {
      ...(b.title !== undefined ? { title: b.title } : {}),
      ...(b.description !== undefined ? { description: b.description } : {}),
      ...(b.startAt !== undefined ? { startAt: b.startAt } : {}),
      ...(b.durationMin !== undefined ? { durationMin: b.durationMin } : {}),
      ...(b.mandatory !== undefined ? { mandatory: b.mandatory } : {}),
      // A new time re-arms the reminders; the sweep skips ones already > 6 h late.
      ...(startChanged ? { remindersSent: "" } : {}),
      updatedAt: b.updatedAt,
    },
  });
  if (count === 0) return conflictAfterRace(res, m.id, "stale");
  const fresh = await prisma.meeting.findUnique({ where: { id: m.id } });
  if (!fresh) return fail(res, 404, "not_found", "No meeting with this uid.");
  const guild = botGuild(env.DISCORD_GUILD_ID);
  if (guild && (startChanged || (b.title !== undefined && b.title !== m.title))) {
    await renotifyMeeting(guild, fresh).catch((err) => logger.warn({ err, uid: m.uid }, "Re-notify after edit failed"));
  }
  return res.json(meetingDto(fresh));
});

/** Cancel before start. Cancelling a cancelled meeting is a no-op 200. */
meetingsRouter.post("/:uid/cancel", async (req, res) => {
  const parsed = cancelSchema.safeParse(req.body ?? {});
  if (!parsed.success) return invalid(res, parsed.error);
  const m = await prisma.meeting.findUnique({ where: { uid: req.params.uid } });
  if (!m) return fail(res, 404, "not_found", "No meeting with this uid.");
  if (m.status === "cancelled") return res.json(meetingDto(m));
  if (m.status !== "scheduled") return fail(res, 409, "already_started", `The meeting is ${m.status}.`, { meeting: meetingDto(m) });
  const fresh = await cancelMeeting(m.id, { source: "ems", updatedAt: parsed.data.updatedAt ?? undefined });
  if (!fresh) {
    // The sweep started it (or another cancel won) between the read and the write.
    const again = await prisma.meeting.findUnique({ where: { id: m.id } });
    if (again?.status === "cancelled") return res.json(meetingDto(again));
    return conflictAfterRace(res, m.id, "already_started", again);
  }
  return res.json(meetingDto(fresh));
});

/**
 * A conditional write matched nothing: re-read and explain. `not_scheduled` /
 * `already_started` when the meeting has moved on, otherwise `fallback` (e.g. stale).
 */
async function conflictAfterRace(
  res: Res,
  id: number,
  fallback: "stale" | "already_started",
  known?: Awaited<ReturnType<typeof prisma.meeting.findUnique>>
) {
  const again = known !== undefined ? known : await prisma.meeting.findUnique({ where: { id } });
  if (!again) return fail(res, 404, "not_found", "No meeting with this uid.");
  if (again.status !== "scheduled") {
    const code = fallback === "already_started" ? "already_started" : "not_scheduled";
    return fail(res, 409, code, `The meeting is ${again.status}.`, { meeting: meetingDto(again) });
  }
  return fail(res, 409, fallback, "The meeting changed while this request was being applied.", { meeting: meetingDto(again) });
}

/**
 * Final attendance rows, for reconcile. Only a completed meeting has final rows
 * (the bot finishes seconds, left_early and leave before marking it completed);
 * anything else answers 409 not_final with the current status.
 */
meetingsRouter.get("/:uid/attendance", async (req, res) => {
  const m = await prisma.meeting.findUnique({ where: { uid: req.params.uid } });
  if (!m) return fail(res, 404, "not_found", "No meeting with this uid.");
  if (m.status !== "completed") {
    return fail(res, 409, "not_final", `Attendance is not final; the meeting is ${m.status}.`, { status: m.status });
  }
  // Stamped before the read, so the rows are at least this fresh; EMS keeps the newest version.
  const generatedAt = new Date().toISOString();
  const rows = await prisma.meetingAttendance.findMany({
    where: { meetingId: m.id },
    select: { userId: true, status: true, minutesLate: true, secondsAttended: true },
    orderBy: { userId: "asc" },
  });
  return res.json({ uid: m.uid, status: m.status, generatedAt, rows: attendanceRows(rows) });
});
