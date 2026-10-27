import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextChannel,
  MessageFlags,
} from "discord.js";
import type { SlashCommand } from "../core/registry.js";
import { addWarn, clearWarns, listWarns } from "../services/warns.js";
import { logEmbed, postLog } from "../lib/log.js";
import { isStaff } from "../lib/rbac.js";

async function ensureStaff(interaction: any): Promise<boolean> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral });
    return false;
  }
  const actor = await interaction.guild.members.fetch(interaction.user.id);
  if (!isStaff(actor) && !actor.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    await interaction.reply({ content: "Not allowed.", flags: MessageFlags.Ephemeral });
    return false;
  }
  return true;
}

export const warn: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false)
    .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true))
    .addBooleanOption((o) => o.setName("list").setDescription("List warns instead"))
    .addBooleanOption((o) => o.setName("clear").setDescription("Clear all warns")),
  async execute(interaction) {
    if (!(await ensureStaff(interaction))) return;
    const user = interaction.options.getUser("member", true);
    const reason = interaction.options.getString("reason", true);
    const list = interaction.options.getBoolean("list") ?? false;
    const clear = interaction.options.getBoolean("clear") ?? false;

    if (list) {
      const warns = await listWarns(interaction.guildId!, user.id);
      await interaction.reply({
        content:
          warns.length === 0
            ? "No warns."
            : warns
                .map(
                  (w) =>
                    `- ${w.createdAt.toISOString()}: ${w.reason} (mod <@${w.modId}>)`
                )
                .join("\n"),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (clear) {
      const { cleared, kept } = await clearWarns(interaction.guildId!, user.id);
      const note = kept
        ? ` Kept ${kept} EMS-issued warning(s): revoke or excuse those in EMS.`
        : "";
      await interaction.reply({ content: `Cleared ${cleared} warn(s).${note}`, flags: MessageFlags.Ephemeral });
      return;
    }

    await addWarn({
      guildId: interaction.guildId!,
      userId: user.id,
      modId: interaction.user.id,
      reason,
    });

    await postLog(
      interaction.guild!,
      "moderation",
      logEmbed("Warn issued", 0xfaa61a)
        .setDescription(`<@${user.id}>: ${reason}`)
        .addFields({ name: "Mod", value: `<@${interaction.user.id}>` })
    );

    await interaction.reply({ content: `Warned <@${user.id}>.`, flags: MessageFlags.Ephemeral });
  },
};

export const timeoutCmd: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Timeout a member (minutes)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false)
    .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true))
    .addIntegerOption((o) =>
      o.setName("minutes").setDescription("Duration").setRequired(true).setMinValue(1).setMaxValue(40320)
    )
    .addStringOption((o) => o.setName("reason").setDescription("Reason")),
  async execute(interaction) {
    if (!(await ensureStaff(interaction))) return;
    const user = interaction.options.getUser("member", true);
    const mins = interaction.options.getInteger("minutes", true);
    const reason = interaction.options.getString("reason") ?? "No reason";
    const member = await interaction.guild!.members.fetch(user.id);
    await member.timeout(mins * 60 * 1000, reason);
    await postLog(
      interaction.guild!,
      "moderation",
      logEmbed("Timeout", 0xed4245)
        .setDescription(`<@${user.id}> for ${mins}m`)
        .addFields(
          { name: "Mod", value: `<@${interaction.user.id}>` },
          { name: "Reason", value: reason }
        )
    );
    await interaction.reply({ content: `Timed out <@${user.id}> for ${mins}m.`, flags: MessageFlags.Ephemeral });
  },
};

export const kick: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .setDMPermission(false)
    .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason")),
  async execute(interaction) {
    if (!(await ensureStaff(interaction))) return;
    const user = interaction.options.getUser("member", true);
    const reason = interaction.options.getString("reason") ?? "No reason";
    const member = await interaction.guild!.members.fetch(user.id);
    await member.kick(reason);
    await postLog(
      interaction.guild!,
      "moderation",
      logEmbed("Kick", 0xed4245).setDescription(`<@${user.id}>`).addFields(
        { name: "Mod", value: `<@${interaction.user.id}>` },
        { name: "Reason", value: reason }
      )
    );
    await interaction.reply({ content: `Kicked <@${user.id}>.`, flags: MessageFlags.Ephemeral });
  },
};

export const ban: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .setDMPermission(false)
    .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason"))
    .addIntegerOption((o) =>
      o.setName("delete_days").setDescription("Days of messages to delete").setMinValue(0).setMaxValue(7)
    ),
  async execute(interaction) {
    if (!(await ensureStaff(interaction))) return;
    const user = interaction.options.getUser("member", true);
    const reason = interaction.options.getString("reason") ?? "No reason";
    const days = interaction.options.getInteger("delete_days") ?? 0;
    await interaction.guild!.bans.create(user.id, {
      reason,
      deleteMessageSeconds: days * 86400,
    });
    await postLog(
      interaction.guild!,
      "moderation",
      logEmbed("Ban", 0xed4245).setDescription(`<@${user.id}>`).addFields(
        { name: "Mod", value: `<@${interaction.user.id}>` },
        { name: "Reason", value: reason }
      )
    );
    await interaction.reply({ content: `Banned <@${user.id}>.`, flags: MessageFlags.Ephemeral });
  },
};

export const purge: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Bulk delete recent messages in this channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false)
    .addIntegerOption((o) =>
      o.setName("count").setDescription("How many (1-100)").setRequired(true).setMinValue(1).setMaxValue(100)
    ),
  async execute(interaction) {
    if (!(await ensureStaff(interaction))) return;
    const count = interaction.options.getInteger("count", true);
    if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
      await interaction.reply({ content: "Text channel only.", flags: MessageFlags.Ephemeral });
      return;
    }
    const ch = interaction.channel as TextChannel;
    const deleted = await ch.bulkDelete(count, true).catch(() => null);
    await postLog(
      interaction.guild!,
      "moderation",
      logEmbed("Purge", 0xfaa61a).setDescription(
        `${deleted?.size ?? 0} messages in <#${ch.id}>`
      ).addFields({ name: "Mod", value: `<@${interaction.user.id}>` })
    );
    await interaction.reply({
      content: `Deleted ${deleted?.size ?? 0} messages.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

export const lock: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("lock")
    .setDescription("Lock this channel (deny SendMessages for @everyone)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .setDMPermission(false),
  async execute(interaction) {
    if (!(await ensureStaff(interaction))) return;
    const ch = interaction.channel;
    if (!ch || ch.type !== ChannelType.GuildText) {
      await interaction.reply({ content: "Text channel only.", flags: MessageFlags.Ephemeral });
      return;
    }
    await (ch as TextChannel).permissionOverwrites.edit(interaction.guild!.roles.everyone, {
      SendMessages: false,
    });
    await interaction.reply({ content: "Locked.", flags: MessageFlags.Ephemeral });
  },
};

export const unlock: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Unlock this channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .setDMPermission(false),
  async execute(interaction) {
    if (!(await ensureStaff(interaction))) return;
    const ch = interaction.channel;
    if (!ch || ch.type !== ChannelType.GuildText) {
      await interaction.reply({ content: "Text channel only.", flags: MessageFlags.Ephemeral });
      return;
    }
    await (ch as TextChannel).permissionOverwrites.edit(interaction.guild!.roles.everyone, {
      SendMessages: null,
    });
    await interaction.reply({ content: "Unlocked.", flags: MessageFlags.Ephemeral });
  },
};

export const slowmode: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("slowmode")
    .setDescription("Set channel slowmode (seconds, 0 = off)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .setDMPermission(false)
    .addIntegerOption((o) =>
      o.setName("seconds").setDescription("0-21600").setRequired(true).setMinValue(0).setMaxValue(21600)
    ),
  async execute(interaction) {
    if (!(await ensureStaff(interaction))) return;
    const ch = interaction.channel;
    if (!ch || ch.type !== ChannelType.GuildText) {
      await interaction.reply({ content: "Text channel only.", flags: MessageFlags.Ephemeral });
      return;
    }
    const sec = interaction.options.getInteger("seconds", true);
    await (ch as TextChannel).setRateLimitPerUser(sec);
    await interaction.reply({ content: `Slowmode: ${sec}s.`, flags: MessageFlags.Ephemeral });
  },
};

export const moderationCommands = [warn, timeoutCmd, kick, ban, purge, lock, unlock, slowmode];
