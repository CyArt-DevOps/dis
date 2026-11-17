import { discordTimestamp } from "../lib/time.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
} from "discord.js";
import { emsPost } from "./emsClient.js";

/**
 * Roster link (EMS spec 2026-11-02 §4): `/link` asks EMS (api/services/rosterLink.js) what to do with this
 * Discord ID. Replies can hold a temporary password, so they are only ever shown ephemerally and never logged.
 */
export interface RosterResult {
  status: string;
  email?: string;
  password?: string;
  portalUrl?: string;
  expiresHours?: number;
  reissued?: boolean;
  /** /reset-password success (EMS spec 2026-11-17 §4 step 7). */
  reset?: boolean;
  maskedEmail?: string;
  mainUsername?: string | null;
  triesLeft?: number;
  /** "busy" only: when EMS calls resume (ISO). */
  retryAt?: string;
}

/** Bot-side display options (never part of an EMS reply). */
export interface RosterMessageOpts {
  /** "busy" / "error": the command the user ran (default /link), named in the reply. */
  command?: string;
}

export const ROSTER_IDS = {
  verify: "emsroster:verify", // button → self-check modal
  verifyModal: "emsroster:verifymodal", // modal: email + last 4 phone digits
  claim: "emsroster:claim", // button → "I filled the form" modal
  claimModal: "emsroster:claimmodal", // modal: full name, email, phone
} as const;

export function startRoster(discordId: string): Promise<RosterResult> {
  return emsPost<RosterResult>("/roster/start", { discordId });
}

export function verifyRoster(discordId: string, email: string, phone: string): Promise<RosterResult> {
  return emsPost<RosterResult>("/roster/verify", { discordId, email, phone });
}

export function claimRoster(discordId: string, name: string, email: string, phone: string): Promise<RosterResult> {
  return emsPost<RosterResult>("/roster/claim", { discordId, name, email, phone });
}

const DISCORD_TAKEN = "Your Discord account is already linked to a different portal profile. Open an HR ticket to change it.";
const masked = (r: RosterResult) => (r.maskedEmail ? escapeMarkdown(r.maskedEmail) : "your email");

/** " 2 tries left today." / " 1 try left today." / " No tries left today. …" / "" when EMS sent no count. */
function triesLeftText(n: number | undefined): string {
  if (typeof n !== "number") return "";
  if (n <= 0) return " No tries left today. Try again in 24 hours or open an HR ticket.";
  return ` ${n} ${n === 1 ? "try" : "tries"} left today.`;
}

export function credentialMessage(r: RosterResult): string {
  return [
    r.reset
      ? "Your portal password was reset. You have been signed out everywhere."
      : r.reissued
        ? "A new temporary password replaces your old one."
        : null,
    "**Your CyArt portal login**",
    `Portal: ${r.portalUrl ?? "https://ems.cyart.io"} · Email: \`${r.email ?? ""}\` · Temporary password: \`${r.password ?? ""}\``,
    `Sign in with it once and set your own password. It expires in ${r.expiresHours ?? 48} hours. Don't share it.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function rosterMessage(r: RosterResult, opts: RosterMessageOpts = {}): string {
  switch (r.status) {
    case "credentials":
      return credentialMessage(r);
    case "already_linked":
      return `Your Discord account is already linked to the portal as **${masked(r)}**. Forgot your password? Run /reset-password.`;
    case "linked_existing":
      return `Linked! Your Discord account is now connected to your portal account (**${masked(r)}**). Sign in with your own password; forgot it? Run /reset-password.`;
    case "existing_account":
      return "A portal account already uses your form email. Please contact HR to link it.";
    case "alt_account":
      return `This looks like a second Discord account. Run /link from your main account${r.mainUsername ? ` **${escapeMarkdown(r.mainUsername)}**` : ""}.`;
    case "verify":
      return "You're on the intern roster, but we need to confirm it's you. Click **Verify my details** and enter the email and phone number you gave in the intern form.";
    case "mismatch":
      return "That doesn't match the form. One more try: click **Verify my details** again.";
    case "sent_for_review":
      return "Sent to HR for review. You'll get a DM when they decide.";
    case "in_review":
      return "Your request is with HR. You'll get a DM when they decide.";
    case "rejected":
      return "HR could not confirm you. Please contact your HR.";
    case "not_listed":
      return "You are not on the intern roster (the intern form was not filled). If you did fill it, click **I filled the form**.";
    case "not_allowed":
      return "There is nothing to do for this account. Run /link again.";
    case "busy": {
      const at = r.retryAt ? new Date(r.retryAt) : null;
      const when = at && !Number.isNaN(at.getTime()) ? ` after ${discordTimestamp(at, "t")} (${discordTimestamp(at, "R")})` : " in about 10 minutes";
      return `The EMS portal is busy right now. Please run ${opts.command ?? "/link"} again${when}. Trying earlier won't help.`;
    }
    case "rate_limited":
      return "Too many tries. Please wait a while and try again.";
    case "discord_taken":
      return DISCORD_TAKEN;
    case "reset_limit":
      return "You've reset your password twice in the last 24 hours. Try again tomorrow or open an HR ticket.";
    case "reset_locked":
      return "Too many wrong emails. Try again in 24 hours or open an HR ticket.";
    case "not_linked":
      return "Your Discord isn't linked to a portal account yet. Run /link first.";
    case "staff_account":
      return "Staff accounts are reset by HR or the Super Admin. Open an HR ticket.";
    case "account_blocked":
      return "This portal account is deactivated. Contact HR.";
    case "email_mismatch":
      return `That email doesn't match the portal account linked to your Discord.${triesLeftText(r.triesLeft)}`;
    default:
      return `${opts.command === "/reset-password" ? "Password reset" : "Linking"} isn't available right now. Please try again later.`;
  }
}

export function rosterComponents(r: RosterResult): ActionRowBuilder<ButtonBuilder>[] {
  if (r.status === "verify" || r.status === "mismatch") {
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(ROSTER_IDS.verify).setLabel("Verify my details").setStyle(ButtonStyle.Primary)
    )];
  }
  if (r.status === "not_listed") {
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(ROSTER_IDS.claim).setLabel("I filled the form").setStyle(ButtonStyle.Secondary)
    )];
  }
  return [];
}

const input = (id: string, label: string, max: number, placeholder: string, min?: number) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short)
    .setRequired(true).setMaxLength(max).setPlaceholder(placeholder);
  if (min) t.setMinLength(min);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(t);
};

export function verifyModal(): ModalBuilder {
  return new ModalBuilder().setCustomId(ROSTER_IDS.verifyModal).setTitle("Confirm it's you").addComponents(
    input("email", "Email you gave in the intern form", 191, "name@example.com"),
    input("phone", "Last 4 digits of that phone number", 4, "1234", 4)
  );
}

export function claimModal(): ModalBuilder {
  return new ModalBuilder().setCustomId(ROSTER_IDS.claimModal).setTitle("I filled the intern form").addComponents(
    input("name", "Full name (as in the form)", 100, "Your full name", 2),
    input("email", "Email you gave in the form", 191, "name@example.com"),
    input("phone", "Phone number you gave in the form", 20, "+91 98765 43210", 4)
  );
}
