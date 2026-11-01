import { escapeMarkdown } from "discord.js";
import { emsPost } from "./emsClient.js";
export const LINK_IDS = {
    begin: "emslink:begin",
    details: "emslink:details", // modal: email + HR name
    enterCode: "emslink:entercode", // button that opens the code modal
    code: "emslink:code", // modal: 6-digit code
};
export function startLink(discordId, email, hrName) {
    return emsPost("/link/start", { discordId, email, hrName });
}
export function confirmLink(discordId, code) {
    return emsPost("/link/confirm", { discordId, code });
}
const LINKED_ELSEWHERE = "That portal profile is already linked to a different Discord account. Open an HR ticket if this is wrong.";
const DISCORD_TAKEN = "Your Discord account is already linked to a different portal profile. Open an HR ticket to change it.";
export function startMessage(r) {
    switch (r.status) {
        case "code_sent":
            // The mask ("r***@x.com") is itself markdown — escape it or it eats the bold.
            return `A 6-digit code was emailed to **${r.maskedEmail ? escapeMarkdown(r.maskedEmail) : "your email"}**. Click **Enter code** below (it expires in 15 minutes).`;
        case "not_found":
            return "No intern profile in the CyArt portal uses that email. Check the spelling, or open an HR ticket.";
        case "hr_mismatch":
            return "Those details didn't match our records. Your request was sent to HR, who will verify and link you.";
        case "already_linked":
            return "Your Discord account is already linked to that portal profile. Nothing to do.";
        case "linked_elsewhere":
            return LINKED_ELSEWHERE;
        case "discord_taken":
            return DISCORD_TAKEN;
        case "email_failed":
            return "We couldn't send the code email right now. Please try again in a few minutes.";
        case "rate_limited":
            return "Too many codes requested. Please wait an hour and try again.";
        default:
            return "Linking isn't available right now. Please try again later.";
    }
}
export function confirmMessage(r) {
    switch (r.status) {
        case "linked":
            return `Linked! Welcome, **${r.name ?? "intern"}** — your Discord account is now connected to the CyArt portal.`;
        case "expired":
            return "That code has expired. Run `/link` again to get a new one.";
        case "too_many_attempts":
            return "Too many wrong attempts. Run `/link` again to get a new code.";
        case "linked_elsewhere":
            return LINKED_ELSEWHERE;
        case "discord_taken":
            return DISCORD_TAKEN;
        default:
            return "That code isn't right. Check the email and try again, or run `/link` for a new code.";
    }
}
//# sourceMappingURL=emsLink.js.map