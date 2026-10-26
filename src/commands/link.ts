import { SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../core/registry.js";
import { detailsModal } from "../interactions/emsLink.js";

export const link: SlashCommand = {
  data: new SlashCommandBuilder().setName("link").setDescription("Link your Discord account to your CyArt portal (EMS) profile"),
  async execute(interaction) {
    await interaction.showModal(detailsModal());
  },
};
