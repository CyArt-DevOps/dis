import { SlashCommandBuilder, MessageFlags } from "discord.js";
import type { SlashCommand } from "../core/registry.js";

export const ping: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Health check"),
  async execute(interaction) {
    await interaction.reply({
      content: `Pong. WS ${interaction.client.ws.ping}ms`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
