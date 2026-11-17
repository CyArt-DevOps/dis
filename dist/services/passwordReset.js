import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import { emsPost } from "./emsClient.js";
/**
 * Discord self-serve password reset (EMS spec 2026-11-17 §5): `/reset-password` opens a modal for the portal
 * email; EMS (api/services/discordPasswordReset.js) checks it against the account linked to this Discord ID and
 * answers in the RosterResult shape. A success holds a temporary password: show it ephemerally, never log it.
 */
export const RESET_IDS = {
    modal: "emsreset:modal", // modal: portal email
    email: "email", // its one text input
};
/** Same check as EMS's route (api/routes/integrationsDis.js EMAIL_RE). */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function resetModal() {
    return new ModalBuilder().setCustomId(RESET_IDS.modal).setTitle("Reset your portal password").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(RESET_IDS.email).setLabel("Portal email").setStyle(TextInputStyle.Short)
        .setRequired(true).setMaxLength(254).setPlaceholder("The email you sign in to the portal with")));
}
export function resetPassword(discordId, email) {
    // 15s, not the 8s default: the api may wait up to 5s for its per-user lock, then hashes and commits. A reply lost
    // after the commit would leave the intern with a changed password they never saw. The reply is already deferred.
    return emsPost("/password/reset", { discordId, email }, 15_000);
}
//# sourceMappingURL=passwordReset.js.map