import {
  ChannelType,
  EmbedBuilder,
  Guild,
  type TextChannel,
} from "discord.js";
import { org } from "../config/loader.js";

export type LogChannel =
  | "audit"
  | "member-events"
  | "voice-events"
  | "moderation"
  | "tickets";

export async function postLog(
  guild: Guild,
  channel: LogChannel,
  embed: EmbedBuilder
): Promise<void> {
  const ch = guild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildText &&
      c.name === channel &&
      c.parent?.name === org.categories.logs.name
  ) as TextChannel | undefined;
  if (!ch) return;
  await ch.send({ embeds: [embed] }).catch(() => {});
}

export function logEmbed(title: string, color = 0x5865f2): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setTimestamp(new Date());
}
