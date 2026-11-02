import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../core/registry.js";
import { linkButtonRow } from "../interactions/emsLink.js";
import { logRosterFailure, replyWith } from "../interactions/rosterLink.js";
import { integrationEnabled } from "../services/emsClient.js";
import { startRoster } from "../services/rosterLink.js";

/**
 * /link (EMS spec 2026-11-02 §4): EMS decides from the intern roster. While no roster is loaded it answers
 * `no_roster` and the older email-code flow is offered (the "Link EMS account" button opens its modal).
 * Every reply is ephemeral: a temporary password may be in it. (Same name and description: no re-register needed.)
 */
export const link: SlashCommand = {
  data: new SlashCommandBuilder().setName("link").setDescription("Link your Discord account to your CyArt portal (EMS) profile"),
  async execute(interaction) {
    if (!integrationEnabled()) {
      await interaction.reply({ content: "Linking isn't available right now.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const r = await startRoster(interaction.user.id);
      if (r.status === "no_roster") {
        await interaction.editReply({ content: "Link your Discord account to your CyArt portal profile:", components: [linkButtonRow()] });
        return;
      }
      await replyWith(interaction, r);
    } catch (err) {
      logRosterFailure("start", interaction.user.id, err);
      await replyWith(interaction, { status: "error" });
    }
  },
};
