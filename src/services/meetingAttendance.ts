import {
  ChannelType,
  Client,
  EmbedBuilder,
  Guild,
  GuildMember,
  type VoiceBasedChannel,
} from "discord.js";
import type { Meeting } from "@prisma/client";
import { prisma } from "../core/db.js";
import { logger } from "../core/logger.js";
import { hasApprovedLeaveCovering, attendanceReportsChannel } from "./leave.js";
import {
  audienceLabel,
  cleanupPeopleMeetingChannel,
  grantAudienceVoiceAccess,
  resolveAudienceRole,
  revokeAudienceVoiceAccess,
} from "./meetingScheduler.js";
import { runEscalations } from "./escalation.js";
import { grantVoiceAccess, type Office } from "./meeting.js";
import { formatInTz } from "../lib/time.js";

let client: Client | null = null;

export function initMeetingAttendance(c: Client): void {
  client = c;
}

function getVoice(guild: Guild, channelId: string): VoiceBasedChannel | null {
  const ch = guild.channels.cache.get(channelId);
  if (ch && (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice))
    return ch as VoiceBasedChannel;
  return null;
}

/**
 * User IDs currently connected to `channelId`, read straight off the voice-state
 * cache. `channel.members` silently drops anyone whose GuildMember isn't cached
 * — in a 500+ member guild that meant real attendees were invisible to the sweep
 * and stayed marked absent. Voice states are keyed by user id and always
 * present, so this sees everyone.
 */
function connectedUserIds(guild: Guild, channelId: string): Set<string> {
  const ids = new Set<string>();
  for (const vs of guild.voiceStates.cache.values()) {
    if (vs.channelId !== channelId) continue;
    if (vs.member?.user.bot) continue;
    ids.add(vs.id);
  }
  return ids;
}

/** Mark a row attended, deriving late-ness from the real join instant. */
async function markAttended(
  rowId: number,
  meeting: Meeting,
  joinedAt: Date
): Promise<void> {
  const windowEndMs = meeting.startAt.getTime() + meeting.attendanceWindowMin * 60_000;
  const joinMs = Math.max(joinedAt.getTime(), meeting.startAt.getTime());
  const onTime = joinMs <= windowEndMs;
  const minutesLate = onTime
    ? 0
    : Math.max(1, Math.ceil((joinMs - meeting.startAt.getTime()) / 60_000));
  await prisma.meetingAttendance.update({
    where: { id: rowId },
    data: { actualJoinAt: new Date(joinMs), status: onTime ? "present" : "late", minutesLate },
  });
}

/** Resolve the meeting's required participants: a role's members, or a named-people list. */
function resolveAudienceMembers(guild: Guild, meeting: Meeting): GuildMember[] {
  if (meeting.audienceType === "people") {
    const ids = (meeting.audienceMemberIds ?? "").split(",").filter(Boolean);
    return ids
      .map((id) => guild.members.cache.get(id))
      .filter((m): m is GuildMember => Boolean(m) && !m!.user.bot);
  }
  const role = resolveAudienceRole(guild, meeting);
  if (!role) return [];
  return Array.from(role.members.filter((m) => !m.user.bot).values());
}

/** At meeting start: snapshot required members and pre-mark excused/absent. */
export async function handleMeetingStart(meeting: Meeting): Promise<void> {
  if (!client) return;
  const guild = client.guilds.cache.get(meeting.guildId);
  if (!guild) return;

  // Role membership is read from cache — without a full fetch, required members
  // are missing from the snapshot entirely.
  await guild.members
    .fetch()
    .catch((err) =>
      logger.warn({ err, meeting: meeting.id }, "Member fetch failed — audience may be incomplete")
    );
  const required = resolveAudienceMembers(guild, meeting);
  if (required.length === 0) {
    logger.warn({ meeting: meeting.id }, "No audience members resolved — cannot track attendance");
    return;
  }

  const profiles = await prisma.member.findMany({
    where: { id: { in: required.map((m) => m.id) } },
  });
  const profileById = new Map(profiles.map((p) => [p.id, p]));

  for (const m of required) {
    const excused = await hasApprovedLeaveCovering(guild.id, m.id, meeting.startAt);
    const p = profileById.get(m.id);
    await prisma.meetingAttendance.upsert({
      where: { meetingId_userId: { meetingId: meeting.id, userId: m.id } },
      create: {
        meetingId: meeting.id,
        userId: m.id,
        fullName: p?.fullName ?? m.displayName,
        batch: p?.batch ?? null,
        project: p?.project ?? null,
        module: p?.module ?? null,
        pod: p?.pod ?? null,
        scheduledStart: meeting.startAt,
        leaveStatus: excused ? "approved" : "none",
        status: excused ? "excused" : "absent",
        minutesLate: 0,
      },
      update: {}, // don't clobber on re-entry
    });
  }

  if (meeting.audienceType === "people" && meeting.office) {
    const office = meeting.office as Office;
    for (const m of required) {
      await grantVoiceAccess(guild, m.id, office, meeting.durationMin, meeting.organizerId).catch(
        (err) => logger.warn({ err, meeting: meeting.id, user: m.id }, "Office VC grant failed")
      );
    }
  } else {
    // Role-based meeting on a private office VC: open it to the audience role for
    // the meeting; revoked in handleMeetingEnd.
    await grantAudienceVoiceAccess(guild, meeting);
  }

  logger.info({ meeting: meeting.id, required: required.length }, "Attendance monitoring started");
  await handleMeetingTick(meeting); // capture anyone already in the VC
}

/** Guards the tick→start self-heal against recursing (start calls tick itself). */
const resnapshotting = new Set<number>();

/** Each sweep during the meeting: record joins for required members in the VC. */
export async function handleMeetingTick(meeting: Meeting): Promise<void> {
  if (!client) return;
  const guild = client.guilds.cache.get(meeting.guildId);
  if (!guild) return;

  // Self-heal: if the start-time snapshot failed (e.g. transient API outage at
  // meeting start), there are no attendance rows — rebuild via the idempotent
  // start handler (it upserts and re-applies the office-VC grant) and retry
  // every sweep until it succeeds.
  const rows = await prisma.meetingAttendance.count({ where: { meetingId: meeting.id } });
  if (rows === 0 && !resnapshotting.has(meeting.id)) {
    resnapshotting.add(meeting.id);
    try {
      logger.warn({ meeting: meeting.id }, "No attendance snapshot — re-running meeting start");
      await handleMeetingStart(meeting);
    } finally {
      resnapshotting.delete(meeting.id);
    }
    return;
  }

  // Retry the office-VC audience grant if it failed at start (no-op when the
  // overwrite is already in place, or for public VCs / people meetings).
  await grantAudienceVoiceAccess(guild, meeting);

  if (!getVoice(guild, meeting.voiceChannelId)) return;

  const present = connectedUserIds(guild, meeting.voiceChannelId);
  if (present.size === 0) return;

  const pending = await prisma.meetingAttendance.findMany({
    where: { meetingId: meeting.id, actualJoinAt: null, status: { not: "excused" } },
  });
  const candidates = pending.filter((r) => present.has(r.userId));
  if (candidates.length === 0) return;

  // Prefer the real join instant from voice tracking over the sweep time: a
  // sweep runs only every 30s, so timing off the sweep marked people late who
  // had actually joined inside the attendance window.
  const sessions = await prisma.voiceSession.findMany({
    where: {
      guildId: meeting.guildId,
      channelId: meeting.voiceChannelId,
      userId: { in: candidates.map((r) => r.userId) },
      leftAt: null,
    },
    select: { userId: true, joinedAt: true },
  });
  const joinedAtByUser = new Map(sessions.map((s) => [s.userId, s.joinedAt]));

  const now = new Date();
  for (const row of candidates) {
    await markAttended(row.id, meeting, joinedAtByUser.get(row.userId) ?? now);
  }
}

/**
 * Last-chance pass over the raw voice sessions for the meeting's channel.
 * The sweep can miss someone who joined and left between two ticks, or during a
 * bot restart; the VoiceSession table records the connection regardless, so any
 * required member whose session overlaps the meeting window gets credited here
 * instead of being reported absent.
 */
async function backfillFromVoiceSessions(meeting: Meeting): Promise<number> {
  const endAt = new Date(
    meeting.startAt.getTime() + (meeting.durationMin + meeting.attendanceWindowMin) * 60_000
  );
  const missing = await prisma.meetingAttendance.findMany({
    where: { meetingId: meeting.id, actualJoinAt: null, status: { not: "excused" } },
    select: { id: true, userId: true },
  });
  if (missing.length === 0) return 0;

  const sessions = await prisma.voiceSession.findMany({
    where: {
      guildId: meeting.guildId,
      channelId: meeting.voiceChannelId,
      userId: { in: missing.map((r) => r.userId) },
      joinedAt: { lt: endAt },
      OR: [{ leftAt: null }, { leftAt: { gt: meeting.startAt } }],
    },
    select: { userId: true, joinedAt: true },
    orderBy: { joinedAt: "asc" },
  });
  if (sessions.length === 0) return 0;

  const firstJoin = new Map<string, Date>();
  for (const s of sessions) if (!firstJoin.has(s.userId)) firstJoin.set(s.userId, s.joinedAt);

  let fixed = 0;
  for (const row of missing) {
    const joinedAt = firstJoin.get(row.userId);
    if (!joinedAt) continue;
    await markAttended(row.id, meeting, joinedAt);
    fixed++;
  }
  if (fixed > 0)
    logger.info({ meeting: meeting.id, fixed }, "Backfilled attendance from voice sessions");
  return fixed;
}

/**
 * Re-check approved leave for anyone still marked absent. Leave approved DURING
 * a meeting (or right after it started) should excuse the member rather than
 * count against them and feed escalation.
 */
async function reexcuseApprovedLeave(meeting: Meeting): Promise<number> {
  const absent = await prisma.meetingAttendance.findMany({
    where: { meetingId: meeting.id, status: "absent" },
    select: { id: true, userId: true },
  });
  let excused = 0;
  for (const row of absent) {
    if (!(await hasApprovedLeaveCovering(meeting.guildId, row.userId, meeting.startAt))) continue;
    await prisma.meetingAttendance.update({
      where: { id: row.id },
      data: { status: "excused", leaveStatus: "approved" },
    });
    excused++;
  }
  return excused;
}

/** At meeting end: generate the attendance report into #attendance-reports. */
export async function handleMeetingEnd(meeting: Meeting): Promise<void> {
  if (!client) return;
  const guild = client.guilds.cache.get(meeting.guildId);
  if (!guild) return;

  // Final pass before the report is written: anyone still in the VC at the last
  // moment, anyone the sweep missed entirely, and anyone whose leave landed late.
  await handleMeetingTick(meeting).catch((err) =>
    logger.warn({ err, meeting: meeting.id }, "Final attendance tick failed")
  );
  await backfillFromVoiceSessions(meeting).catch((err) =>
    logger.warn({ err, meeting: meeting.id }, "Attendance backfill failed")
  );
  await reexcuseApprovedLeave(meeting).catch((err) =>
    logger.warn({ err, meeting: meeting.id }, "Leave re-check failed")
  );

  const rows = await prisma.meetingAttendance.findMany({ where: { meetingId: meeting.id } });
  const present = rows.filter((r) => r.status === "present");
  const late = rows.filter((r) => r.status === "late");
  const excused = rows.filter((r) => r.status === "excused");
  const absent = rows.filter((r) => r.status === "absent");

  const organizer = `<@${meeting.organizerId}>`;
  const embed = new EmbedBuilder()
    .setTitle(`Attendance Report: ${meeting.title}`)
    .setColor(absent.length > 0 ? 0xed4245 : 0x57f287)
    .addFields(
      { name: "Date / Time", value: formatInTz(meeting.startAt), inline: true },
      { name: "Duration", value: `${meeting.durationMin} min`, inline: true },
      { name: "Organizer", value: organizer, inline: true },
      { name: "Audience", value: audienceLabel(meeting), inline: true },
      { name: "Voice channel", value: `<#${meeting.voiceChannelId}>`, inline: true },
      { name: "Expected", value: String(rows.length), inline: true },
      {
        name: "Summary",
        value: `Present: **${present.length}**   Late: **${late.length}**   Excused: **${excused.length}**   Absent: **${absent.length}**`,
      }
    )
    .setTimestamp(new Date());

  const lineFor = (r: (typeof rows)[number]) =>
    `- ${r.fullName ?? `<@${r.userId}>`} : ${r.project ?? "?"} M${r.module ?? "?"} P${r.pod ?? "?"} (<@${r.userId}>)`;

  if (absent.length > 0) {
    const list = absent.slice(0, 20).map(lineFor).join("\n");
    embed.addFields({
      name: `Absent without approved leave (${absent.length})`,
      value: list.slice(0, 1024) + (absent.length > 20 ? `\n+${absent.length - 20} more` : ""),
    });
  }
  if (late.length > 0) {
    const list = late
      .slice(0, 15)
      .map((r) => `- ${r.fullName ?? `<@${r.userId}>`} : ${r.minutesLate} minutes late`)
      .join("\n");
    embed.addFields({ name: `Late arrivals (${late.length})`, value: list.slice(0, 1024) });
  }

  const ch = attendanceReportsChannel(guild);
  if (ch) {
    await ch.send({ embeds: [embed] }).catch((err) =>
      logger.warn({ err, meeting: meeting.id }, "Could not post attendance report")
    );
  } else {
    logger.warn("No #attendance-reports channel — run /setup");
  }
  logger.info(
    { meeting: meeting.id, present: present.length, late: late.length, excused: excused.length, absent: absent.length },
    "Attendance report generated"
  );

  // Escalate repeat unexcused absentees (3/5/7/10 thresholds).
  await runEscalations(
    guild,
    absent.map((r) => ({
      userId: r.userId,
      fullName: r.fullName,
      batch: r.batch,
      project: r.project,
      module: r.module,
      pod: r.pod,
    }))
  ).catch((err) => logger.warn({ err }, "Escalation run failed"));

  // Tear down the private notification channel for people meetings.
  await cleanupPeopleMeetingChannel(guild, meeting).catch((err) =>
    logger.warn({ err, meeting: meeting.id }, "Could not delete meeting notify channel")
  );

  // Revoke any temporary office-VC access opened for a role-based audience.
  await revokeAudienceVoiceAccess(guild, meeting).catch((err) =>
    logger.warn({ err, meeting: meeting.id }, "Could not revoke office VC access")
  );
}
