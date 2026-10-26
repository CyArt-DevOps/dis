import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../core/registry.js";
import { detailsModal } from "../interactions/emsLink.js";
import { integrationEnabled } from "../services/emsClient.js";

export const link: SlashCommand = {
  data: new SlashCommandBuilder().setName("link").setDescription("Link your Discord account to your CyArt portal (EMS) profile"),
  async execute(interaction) {
    if (!integrationEnabled()) {
      await interaction.reply({ content: "Linking isn't available right now.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(detailsModal());
  },
};
