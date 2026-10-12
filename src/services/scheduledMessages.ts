import {
  ActionRowBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
} from "discord.js";
import type { ScheduledMessage } from "@prisma/client";
import { prisma } from "../core/db.js";
import { logger } from "../core/logger.js";
import { isStaff } from "../lib/rbac.js";
import { discordTimestamp, formatInTz } from "../lib/time.js";

let client: Client | null = null;
let sweepTimer: NodeJS.Timeout | null = null;

/** How far ahead a message may be scheduled. */
export const MAX_LEAD_MS = 365 * 24 * 3600_000;
/** Minimum lead time — below this, just post it yourself. */
export const MIN_LEAD_MS = 60_000;
/** A pending message older than this past its send time is stale (bot was down). */
const STALE_AFTER_MS = 3600_000;

export const SCHEDULE_IDS = { modal: "schedule:msg" } as const;

/** Max body length. Embed descriptions cap at 4096; this leaves ample headroom. */
export const MAX_CONTENT = 2000;

/**
 * Slash-command string options are single-line — Discord's client won't accept
 * a newline in them. A modal with a Paragraph input is the only native way to
 * collect a multi-line body, so /schedule create opens this instead of taking
 * the text as an option. Channel + send time ride along in the custom id
 * (well under the 100-char limit) so the submit handler stays stateless.
 */
export function messageModal(channelId: string, sendAt: Date): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${SCHEDULE_IDS.modal}:${channelId}:${sendAt.getTime()}`)
    .setTitle("Schedule a message")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("message")
          .setLabel("Message")
          .setPlaceholder("Line breaks and blank lines are kept exactly as typed.")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(MAX_CONTENT)
          .setRequired(true)
      )
    );
}

export type ScheduleFailure =
  | "not_text"
  | "author_cannot_send"
  | "bot_cannot_send"
  | "too_soon"
  | "too_far";

/**
 * Verify the ACTOR may post in the target channel. Without this, /schedule
 * would be a way to launder a message into a channel the author has no access
 * to — the bot posts it, so Discord's own permission check never sees them.
 */
export function checkTarget(
  channel: GuildTextBasedChannel,
  actor: GuildMember,
  sendAt: Date
): ScheduleFailure | null {
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
    return "not_text";

  const actorPerms = channel.permissionsFor(actor);
  if (!actorPerms?.has(PermissionFlagsBits.SendMessages) || !actorPerms.has(PermissionFlagsBits.ViewChannel))
    return "author_cannot_send";

  const me = channel.guild.members.me;
  const botPerms = me ? channel.permissionsFor(me) : null;
  if (!botPerms?.has(PermissionFlagsBits.SendMessages)) return "bot_cannot_send";

  const lead = sendAt.getTime() - Date.now();
  if (lead < MIN_LEAD_MS) return "too_soon";
  if (lead > MAX_LEAD_MS) return "too_far";
  return null;
}

export async function createScheduled(args: {
  guildId: string;
  channelId: string;
  authorId: string;
  content: string;
  sendAt: Date;
}): Promise<ScheduledMessage> {
  const row = await prisma.scheduledMessage.create({ data: { ...args, status: "pending" } });
  logger.info(
    { scheduled: row.id, author: args.authorId, sendAt: args.sendAt.toISOString() },
    "Message scheduled"
  );
  return row;
}

/** A member's own pending messages. Staff see everything in the guild. */
export async function listScheduled(
  guildId: string,
  member: GuildMember
): Promise<ScheduledMessage[]> {
  return prisma.scheduledMessage.findMany({
    where: {
      guildId,
      status: "pending",
      ...(isStaff(member) ? {} : { authorId: member.id }),
    },
    orderBy: { sendAt: "asc" },
    take: 25,
  });
}

export type CancelResult = "ok" | "not_found" | "forbidden" | "already_done";

/** Authors cancel their own; staff cancel anyone's. */
export async function cancelScheduled(
  guildId: string,
  id: number,
  member: GuildMember
): Promise<CancelResult> {
  const row = await prisma.scheduledMessage.findUnique({ where: { id } });
  if (!row || row.guildId !== guildId) return "not_found";
  if (row.status !== "pending") return "already_done";
  if (row.authorId !== member.id && !isStaff(member)) return "forbidden";

  await prisma.scheduledMessage.update({ where: { id }, data: { status: "cancelled" } });
  logger.info({ scheduled: id, by: member.id }, "Scheduled message cancelled");
  return "ok";
}

/**
 * Build the delivered message. The bot posts it, with the author credited —
 * a bot cannot post as a real user, so attribution is explicit rather than
 * impersonated.
 */
function deliveryPayload(row: ScheduledMessage, guild: Guild) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setDescription(row.content)
    .setFooter({ text: `Scheduled by ${guild.members.cache.get(row.authorId)?.displayName ?? "a member"}` })
    .setTimestamp(row.sendAt);

  return {
    content: `<@${row.authorId}> scheduled this message:`,
    embeds: [embed],
    // Ping the author only. Blocks @everyone/@here and role pings smuggled into
    // the body — the scheduler runs unattended, so nothing else may mention.
    allowedMentions: { users: [row.authorId] as string[] },
  };
}

async function deliver(row: ScheduledMessage): Promise<void> {
  if (!client) return;

  const fail = async (reason: string) => {
    await prisma.scheduledMessage.update({
      where: { id: row.id },
      data: { status: "failed", error: reason },
    });
    logger.warn({ scheduled: row.id, reason }, "Scheduled message not delivered");
  };

  // Bot was down past the send time by more than the stale window — don't
  // surprise a channel with a message that reads as current but isn't.
  if (Date.now() - row.sendAt.getTime() > STALE_AFTER_MS) {
    await fail("missed send window while offline");
    return;
  }

  const guild = client.guilds.cache.get(row.guildId);
  if (!guild) return void (await fail("guild unavailable"));

  const channel = guild.channels.cache.get(row.channelId);
  if (!channel || !channel.isTextBased()) return void (await fail("channel missing"));

  // Re-check at send time: the author may have lost access since scheduling.
  const author = await guild.members.fetch(row.authorId).catch(() => null);
  if (!author) return void (await fail("author left the server"));
  if (!channel.permissionsFor(author)?.has(PermissionFlagsBits.SendMessages))
    return void (await fail("author no longer has access to the channel"));

  try {
    const sent = await channel.send(deliveryPayload(row, guild));
    await prisma.scheduledMessage.update({
      where: { id: row.id },
      data: { status: "sent", sentAt: new Date(), messageId: sent.id },
    });
    logger.info({ scheduled: row.id, channel: channel.id }, "Scheduled message sent");
  } catch (err) {
    await fail(err instanceof Error ? err.message : "send failed");
  }
}

async function sweep(): Promise<void> {
  const due = await prisma.scheduledMessage.findMany({
    where: { status: "pending", sendAt: { lte: new Date() } },
    orderBy: { sendAt: "asc" },
    take: 50,
  });
  for (const row of due) await deliver(row);
}

export function startScheduledMessages(c: Client): void {
  client = c;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = setInterval(
    () => void sweep().catch((err) => logger.error({ err }, "Scheduled message sweep error")),
    30_000
  );
  void sweep().catch((err) => logger.error({ err }, "Scheduled message sweep error"));
  logger.info("Scheduled message sweep started");
}

export function stopScheduledMessages(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

/** One-line summary for /schedule list. */
export function summarize(row: ScheduledMessage): string {
  // Flatten newlines — a multi-line body would break out of the `>` quote below.
  const oneLine = row.content.replace(/\s*\n+\s*/g, " ⏎ ").trim();
  const preview = oneLine.length > 60 ? oneLine.slice(0, 57) + "..." : oneLine;
  return `**#${row.id}** — ${discordTimestamp(row.sendAt, "f")} (${formatInTz(row.sendAt)}) in <#${row.channelId}>\n> ${preview}`;
}
