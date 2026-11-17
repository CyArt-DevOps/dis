import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../core/registry.js";
import { integrationEnabled } from "../services/emsClient.js";
import { resetModal } from "../services/passwordReset.js";

/**
 * /reset-password (EMS spec 2026-11-17 §3, §5): opens a modal asking for the portal email. showModal must be the
 * first response, so nothing is deferred here; the modal submit (interactions/passwordReset.ts) calls EMS.
 */
export const resetPasswordCommand: SlashCommand = {
  data: new SlashCommandBuilder().setName("reset-password").setDescription("Reset your CyArt portal password"),
  async execute(interaction) {
    if (!integrationEnabled()) {
      await interaction.reply({ content: "Password reset isn't available right now.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(resetModal());
  },
};
