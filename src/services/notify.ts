import {
  ChannelType,
  type ActionRowBuilder,
  type ButtonBuilder,
  type EmbedBuilder,
  type Guild,
  type ThreadChannel,
} from "discord.js";
import { prisma } from "../core/db.js";
import { logger } from "../core/logger.js";
import { botClient } from "../core/botClient.js";
import { memberChannel } from "./voiceSummary.js";

/**
 * Reach a member privately: DM first, and when that fails (DMs closed, or the
 * bot is under Discord's DM quarantine) a private thread in their own team
 * channel that only they and staff can see. Used for warnings and leave
 * decisions, which must not silently go undelivered.
 *
 * Discord flags bots that keep attempting DMs while quarantined, so once a
 * quarantine error is seen DMs are skipped for a while and threads are used
 * directly.
 */

const QUARANTINE_CODE = 20026; // "Your bot has been flagged by our anti-spam system"
const DM_PAUSE_MS = 6 * 3600_000;
let dmPausedUntil = 0;

export function dmPaused(): boolean {
  return Date.now() < dmPausedUntil;
}

/** Discord quarantined the bot's DMs (20026): stop attempting DMs for a while. */
export function pauseDms(): void {
  dmPausedUntil = Date.now() + DM_PAUSE_MS;
  logger.warn("Discord DM quarantine detected: using private threads for 6 hours");
}

export interface Delivery {
  via: "dm" | "thread" | "none";
  channelId: string | null;
  messageId: string | null;
}

export interface NotifyPayload {
  embeds: EmbedBuilder[];
  components?: ActionRowBuilder<ButtonBuilder>[];
  /** Thread title when the DM can't be delivered, e.g. "Warning #12". */
  threadName: string;
}

export async function notifyMember(guild: Guild, userId: string, payload: NotifyPayload): Promise<Delivery> {
  const client = botClient();
  if (!client) return { via: "none", channelId: null, messageId: null };

  if (!dmPaused()) {
    try {
      const user = await client.users.fetch(userId);
      const msg = await user.send({ embeds: payload.embeds, components: payload.components });
      return { via: "dm", channelId: msg.channelId, messageId: msg.id };
    } catch (err) {
      if ((err as { code?: number }).code === QUARANTINE_CODE) pauseDms();
    }
  }

  const thread = await privateThreadFor(guild, userId, payload.threadName);
  if (!thread) return { via: "none", channelId: null, messageId: null };
  try {
    const msg = await thread.send({
      content: `<@${userId}>`,
      embeds: payload.embeds,
      components: payload.components,
      allowedMentions: { users: [userId] },
    });
    return { via: "thread", channelId: thread.id, messageId: msg.id };
  } catch (err) {
    logger.warn({ err, userId }, "Private thread notification failed");
    return { via: "none", channelId: null, messageId: null };
  }
}

/** A private thread in the member's pod/module/project channel, with them added. */
async function privateThreadFor(guild: Guild, userId: string, name: string): Promise<ThreadChannel | null> {
  const m = await prisma.member.findUnique({ where: { id: userId }, select: { project: true, module: true, pod: true } });
  const parent = m ? memberChannel(guild, m) : null;
  if (!parent) return null;
  try {
    const thread = await parent.threads.create({
      name: name.slice(0, 90),
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: 10080,
      reason: "Private notice: DM not deliverable",
    });
    await thread.members.add(userId).catch(() => {});
    return thread;
  } catch (err) {
    logger.warn({ err, userId, channel: parent.name }, "Could not create private thread");
    return null;
  }
}
