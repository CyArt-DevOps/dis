import {
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  type GuildTextBasedChannel,
} from "discord.js";
import type { SlashCommand } from "../core/registry.js";
import {
  cancelScheduled,
  checkTarget,
  listScheduled,
  messageModal,
  summarize,
  type ScheduleFailure,
} from "../services/scheduledMessages.js";
import { parseDateTime, tzName } from "../lib/time.js";

const FAILURE_TEXT: Record<ScheduleFailure, string> = {
  not_text: "That channel isn't a text channel.",
  author_cannot_send: "You don't have permission to post in that channel.",
  bot_cannot_send: "I don't have permission to post in that channel.",
  too_soon: "Pick a time at least a minute from now.",
  too_far: "That's more than a year out.",
};

export const schedule: SlashCommand = {
  get data() {
    return new SlashCommandBuilder()
      .setName("schedule")
      .setDescription("Schedule a message to be posted later")
      .setDMPermission(false)
      .addSubcommand((s) =>
        s
          .setName("create")
          .setDescription("Schedule a message in a channel")
          .addChannelOption((o) =>
            o
              .setName("channel")
              .setDescription("Where to post it")
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
              .setRequired(true)
          )
          .addStringOption((o) =>
            o.setName("date").setDescription("DD/MM/YYYY").setRequired(true)
          )
          .addStringOption((o) =>
            o.setName("time").setDescription("h:mm AM/PM").setRequired(true)
          )
      )
      .addSubcommand((s) =>
        s.setName("list").setDescription("Show your pending scheduled messages")
      )
      .addSubcommand((s) =>
        s
          .setName("cancel")
          .setDescription("Cancel a pending scheduled message")
          .addIntegerOption((o) =>
            o.setName("id").setDescription("ID from /schedule list").setRequired(true).setMinValue(1)
          )
      );
  },

  async execute(interaction) {
    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral });
      return;
    }
    // `create` answers with showModal, which cannot be deferred — so avoid the
    // REST round trip and use the member Discord sent with the interaction.
    const member = interaction.member;
    const sub = interaction.options.getSubcommand();

    // `create` collects the body in a modal (multi-line), and showModal IS the
    // acknowledgement — so this path must not defer.
    if (sub === "create") {
      const channel = interaction.options.getChannel("channel", true) as GuildTextBasedChannel;
      const sendAt = parseDateTime(
        interaction.options.getString("date", true),
        interaction.options.getString("time", true)
      );
      if (!sendAt) {
        await interaction.reply({
          content: `Couldn't read that date/time. Use \`DD/MM/YYYY\` and \`h:mm AM/PM\` (e.g. \`25/07/2026\` and \`9:30 AM\`), in ${tzName()}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const failure = checkTarget(channel, member, sendAt);
      if (failure) {
        await interaction.reply({ content: FAILURE_TEXT[failure], flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.showModal(messageModal(channel.id, sendAt));
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (sub === "list") {
      const rows = await listScheduled(interaction.guildId, member);
      await interaction.editReply({
        content: rows.length
          ? `**Pending scheduled messages**\n\n${rows.map(summarize).join("\n\n")}`
          : "Nothing scheduled.",
      });
      return;
    }

    if (sub === "cancel") {
      const id = interaction.options.getInteger("id", true);
      const result = await cancelScheduled(interaction.guildId, id, member);
      const text = {
        ok: `Cancelled **#${id}**.`,
        not_found: `No scheduled message **#${id}** here.`,
        forbidden: "You can only cancel your own scheduled messages.",
        already_done: `**#${id}** was already sent or cancelled.`,
      }[result];
      await interaction.editReply({ content: text });
    }
  },
};
