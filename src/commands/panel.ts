import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextChannel,
  MessageFlags,
} from "discord.js";
import type { SlashCommand } from "../core/registry.js";
import { isStaff } from "../lib/rbac.js";
import { beginButton } from "../services/onboarding.js";
import {
  panelButton,
  panelEmbed,
  staffTalkPanelButtons,
  staffTalkPanelEmbed,
} from "../services/tickets.js";

function verifyEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Start Here — Verification")
    .setDescription(
      "Click **Begin Verification** and select your **Batch → Project → Module → Pod**. Roles are assigned automatically."
    )
    .setColor(0x5865f2);
}

export const panel: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Post an interactive panel in this channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .setDMPermission(false)
    .addSubcommand((sc) =>
      sc.setName("verify").setDescription("Post the verification panel here")
    )
    .addSubcommand((sc) =>
      sc.setName("ticket").setDescription("Post the ticket panel here")
    )
    .addSubcommand((sc) =>
      sc
        .setName("staff")
        .setDescription("Post the Talk to Manager / Talk to HR panel here")
    ),
  async execute(interaction) {
    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral });
      return;
    }
    const actor = await interaction.guild.members.fetch(interaction.user.id);
    if (!isStaff(actor)) {
      await interaction.reply({ content: "Staff only.", flags: MessageFlags.Ephemeral });
      return;
    }
    const ch = interaction.channel;
    if (!ch || ch.type !== ChannelType.GuildText) {
      await interaction.reply({ content: "Text channel only.", flags: MessageFlags.Ephemeral });
      return;
    }

    const sub = interaction.options.getSubcommand();
    if (sub === "verify") {
      await (ch as TextChannel).send({ embeds: [verifyEmbed()], components: [beginButton()] });
    } else if (sub === "staff") {
      await (ch as TextChannel).send({
        embeds: [staffTalkPanelEmbed()],
        components: [staffTalkPanelButtons()],
      });
    } else {
      await (ch as TextChannel).send({ embeds: [panelEmbed()], components: [panelButton()] });
    }
    await interaction.reply({ content: "Panel posted.", flags: MessageFlags.Ephemeral });
  },
};
