import type { Interaction, GuildTextBasedChannel } from "discord.js";
import type { InteractionHandler } from "../core/registry.js";
import {
  SCHEDULE_IDS,
  checkTarget,
  createScheduled,
} from "../services/scheduledMessages.js";
import { discordTimestamp, formatInTz, tzName } from "../lib/time.js";

function cid(i: Interaction): string | undefined {
  return i.isModalSubmit() ? i.customId : undefined;
}

const FAILURE_TEXT: Record<string, string> = {
  not_text: "That channel isn't a text channel.",
  author_cannot_send: "You don't have permission to post in that channel.",
  bot_cannot_send: "I don't have permission to post in that channel.",
  too_soon: "That time has already passed — schedule it again.",
  too_far: "That's more than a year out.",
};

export const scheduleModalHandler: InteractionHandler = {
  id: "schedule:modal",
  // createScheduled writes to the DB — defer so the 3s window can't bite.
  ack: "reply",
  matches: (i) =>
    i.isModalSubmit() && (cid(i)?.startsWith(SCHEDULE_IDS.modal + ":") ?? false),
  async handle(i) {
    if (!i.isModalSubmit() || !i.inCachedGuild()) return;

    const [, , channelId, sendAtMs] = cid(i)!.split(":");
    const sendAt = new Date(Number(sendAtMs));
    const channel = i.guild.channels.cache.get(channelId ?? "");
    if (!channel || !channel.isTextBased()) {
      await i.editReply({ content: "That channel no longer exists." });
      return;
    }

    const member = await i.guild.members.fetch(i.user.id);
    // Re-check: the user spent time typing, so the send time may now be in the
    // past and permissions may have changed since the command was run.
    const failure = checkTarget(channel as GuildTextBasedChannel, member, sendAt);
    if (failure) {
      await i.editReply({ content: FAILURE_TEXT[failure] ?? "Can't schedule that." });
      return;
    }

    const content = i.fields.getTextInputValue("message");
    const row = await createScheduled({
      guildId: i.guildId,
      channelId: channel.id,
      authorId: member.id,
      content,
      sendAt,
    });

    await i.editReply({
      content:
        `Scheduled **#${row.id}** for ${discordTimestamp(sendAt, "F")} (${formatInTz(sendAt)} ${tzName()}) in <#${channel.id}>.\n` +
        `It will be posted by me and credited to you — Discord doesn't let a bot post as your account.\n` +
        `Cancel with \`/schedule cancel id:${row.id}\`.`,
    });
  },
};
