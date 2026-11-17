import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import { emsPost } from "./emsClient.js";
import type { RosterResult } from "./rosterLink.js";

/**
 * Discord self-serve password reset (EMS spec 2026-11-17 §5): `/reset-password` opens a modal for the portal
 * email; EMS (api/services/discordPasswordReset.js) checks it against the account linked to this Discord ID and
 * answers in the RosterResult shape. A success holds a temporary password: show it ephemerally, never log it.
 */
export const RESET_IDS = {
  modal: "emsreset:modal", // modal: portal email
  email: "email", // its one text input
} as const;

/** Same check as EMS's route (api/routes/integrationsDis.js EMAIL_RE). */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function resetModal(): ModalBuilder {
  return new ModalBuilder().setCustomId(RESET_IDS.modal).setTitle("Reset your portal password").addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId(RESET_IDS.email).setLabel("Portal email").setStyle(TextInputStyle.Short)
        .setRequired(true).setMaxLength(254).setPlaceholder("The email you sign in to the portal with")
    )
  );
}

export function resetPassword(discordId: string, email: string): Promise<RosterResult> {
  return emsPost<RosterResult>("/password/reset", { discordId, email });
}
