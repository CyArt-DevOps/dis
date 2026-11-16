import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type Client,
  type GuildMember,
} from "discord.js";
import { prisma } from "../core/db.js";
import { logger } from "../core/logger.js";
import { env } from "../config/env.js";
import { panelNeedsEdit } from "../lib/panelRefresh.js";
import { integrationEnabled } from "./emsClient.js";
import { deriveMembership } from "../lib/membership.js";

/**
 * Tenure Completed (2026-11-16). The bot posts the EMS access announcement in one
 * channel with a "Tenure Completed" button. Interns whose internship has ended
 * press it, confirm, and fill a short form; HR sees the list on the dashboard.
 */
export const TENURE_IDS = {
  start: "tenure:start",
  confirm: "tenure:confirm",
  form: "tenure:form",
} as const;

const SETTING_KEY = "tenureAnnouncement";

export const TENURE_TITLE = "Announcement: EMS Portal Access";

export const TENURE_DESCRIPTION = [
  "Dear Team,",
  "",
  "Welcome back. We hope you had a joyful and restful Diwali with your loved ones.",
  "",
  "Today is our first working day after the festive break, and we're using it to introduce some new procedures. The first of these is the **CyArt Employee Management System (EMS)**, available at **https://ems.cyart.io**. Starting today, EMS is the official platform for attendance, daily plans, task updates, end-of-day reports and leave requests.",
  "",
  "**How to get your EMS access**",
  "1. In the CyArt Discord server, type **`/link`** and select the command from the bot.",
  "2. The bot replies with a private message that only you can see. It contains the portal link, your login email and a temporary password.",
  "3. Go to **https://ems.cyart.io** and sign in with these details.",
  "4. When prompted, set a new password of your own.",
  "",
  "**Please note**",
  "• The temporary password expires **48 hours** after it is issued. Please complete this process **today**.",
  "• Your login details are confidential. Do not share your password or screenshots of the bot's reply with anyone.",
  "• Run `/link` from the Discord account you registered in the intern form.",
  "• When you sign in for the first time, a short guided tour introduces the portal. Please complete it.",
  "• **If your internship tenure is complete, you don't need to follow this procedure.** Instead, click **Tenure Completed** below and fill in the short form.",
  "",
  "**If the bot asks for more information**",
  "• **\"Verify my details\"**: Enter the email address and phone number you gave in the intern form.",
  "• **\"Not on the intern roster\"**: If you did submit the form, select **\"I filled the form\"**. HR will review your request and contact you on Discord.",
  "• **\"Already linked\"**, or you have forgotten your password: Please contact HR.",
  "• **\"Too many tries\"**: Please wait a while before trying again.",
  "",
  "As we begin this new chapter, we're counting on your cooperation in making EMS part of your daily routine. If you have any questions, please contact HR.",
  "",
  "Warm regards,",
  "**HR Team, CyArt**",
].join("\n");

export function tenureButtonRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(TENURE_IDS.start).setLabel("Tenure Completed").setEmoji("🎓").setStyle(ButtonStyle.Secondary)
  );
}

export function tenureEmbed(): EmbedBuilder {
  return new EmbedBuilder().setColor(0xff6b2c).setTitle(TENURE_TITLE).setDescription(TENURE_DESCRIPTION);
}

// ---------------------------------------------------------------------------
// Form parsing (pure)

export interface TenureForm {
  name: string;
  email: string;
  phone: string;
  handoverDone: boolean;
  handoverDate: string | null;
}

export type ParseResult = { ok: true; value: TenureForm } | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** "YYYY-MM-DD", "DD-MM-YYYY" or "DD/MM/YYYY" → "YYYY-MM-DD", or null if not a real date. */
export function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let hit = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (hit) {
    [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  } else {
    hit = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
    if (!hit) return null;
    [d, m, y] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 2020 || y > 2100) return null;
  return dt.toISOString().slice(0, 10);
}

export function parseTenureForm(raw: { name: string; email: string; phone: string; handover: string; date: string }): ParseResult {
  const name = raw.name.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 100) return { ok: false, error: "Please enter your full name." };

  const email = raw.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 191) return { ok: false, error: "Please enter a valid email address." };

  const phone = raw.phone.trim();
  const digits = phone.replace(/\D/g, "");
  if (!/^\+?[\d\s()-]+$/.test(phone) || digits.length < 10 || digits.length > 15) {
    return { ok: false, error: "Please enter a valid phone number (10 to 15 digits)." };
  }

  const h = raw.handover.trim().toLowerCase();
  let handoverDone: boolean;
  if (["yes", "y"].includes(h)) handoverDone = true;
  else if (["no", "n"].includes(h)) handoverDone = false;
  else return { ok: false, error: "For \"Project handover done?\", please answer Yes or No." };

  const rawDate = raw.date.trim();
  let handoverDate: string | null = null;
  if (rawDate) {
    handoverDate = normalizeDate(rawDate);
    if (!handoverDate) return { ok: false, error: "Please enter the handover date as DD-MM-YYYY (for example 14-11-2026)." };
  } else if (handoverDone) {
    return { ok: false, error: "Please enter the date of your project handover." };
  }

  return { ok: true, value: { name, email, phone: digits.length === phone.length ? digits : phone.replace(/\s+/g, " "), handoverDone, handoverDate } };
}

// ---------------------------------------------------------------------------
// Storage

export async function saveTenure(member: GuildMember, form: TenureForm): Promise<void> {
  const { project, moduleNum, podNum } = deriveMembership(member);
  const data = {
    guildId: member.guild.id,
    username: member.user.username.slice(0, 100),
    ...form,
    project: project?.name?.slice(0, 100) ?? null,
    moduleNum: moduleNum ?? null,
    podNum: podNum ?? null,
  };
  await prisma.tenureCompletion.upsert({ where: { userId: member.id }, create: { userId: member.id, ...data }, update: data });
}

export interface TenureRow {
  userId: string;
  username: string;
  name: string;
  email: string;
  phone: string;
  handoverDone: boolean;
  handoverDate: string | null;
  project: string | null;
  moduleNum: number | null;
  podNum: number | null;
  submittedAt: string;
}

export async function listTenure(guildId: string): Promise<TenureRow[]> {
  const rows = await prisma.tenureCompletion.findMany({ where: { guildId }, orderBy: { updatedAt: "desc" } });
  return rows.map((r) => ({
    userId: r.userId,
    username: r.username,
    name: r.name,
    email: r.email,
    phone: r.phone,
    handoverDone: r.handoverDone,
    handoverDate: r.handoverDate,
    project: r.project,
    moduleNum: r.moduleNum,
    podNum: r.podNum,
    submittedAt: r.updatedAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// The announcement itself

/**
 * Post the announcement once in TENURE_CHANNEL_ID, or edit it in place when its text
 * changed. The posted message id lives in BotSetting, so a busy channel never gets a
 * second copy. Skipped while the EMS integration is off (the message tells people to
 * run /link, which would not work then).
 */
export async function ensureTenureAnnouncement(client: Client): Promise<"posted" | "edited" | "unchanged" | "skipped"> {
  if (!integrationEnabled()) {
    logger.info("Tenure announcement skipped: EMS integration is off");
    return "skipped";
  }
  const channel = await client.channels.fetch(env.TENURE_CHANNEL_ID).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    logger.info({ channel: env.TENURE_CHANNEL_ID }, "Tenure announcement skipped: channel not found");
    return "skipped";
  }
  const me = channel.guild.members.me;
  if (me && !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    logger.warn({ channel: channel.id }, "Tenure announcement skipped: missing permissions");
    return "skipped";
  }

  const payload = { embeds: [tenureEmbed()], components: [tenureButtonRow()] };
  const saved = await prisma.botSetting.findUnique({ where: { key: SETTING_KEY } });
  let ref: { channelId?: string; messageId?: string } = {};
  try {
    ref = saved ? (JSON.parse(saved.value) as typeof ref) : {};
  } catch {
    ref = {};
  }

  if (ref.channelId === channel.id && ref.messageId) {
    const msg = await channel.messages.fetch(ref.messageId).catch(() => null);
    if (msg) {
      const wanted = { title: TENURE_TITLE, description: TENURE_DESCRIPTION };
      const suppressed = msg.flags.has("SuppressEmbeds");
      if (!panelNeedsEdit(msg.embeds, suppressed, wanted)) return "unchanged";
      await msg.edit({ ...payload, flags: [] });
      logger.info({ message: msg.id }, "Tenure announcement edited");
      return "edited";
    }
  }

  // First post pings @everyone (needs Mention Everyone; without it Discord shows the text but pings no one).
  if (me && !channel.permissionsFor(me)?.has(PermissionFlagsBits.MentionEveryone)) {
    logger.warn({ channel: channel.id }, "Tenure announcement: bot lacks Mention Everyone, @everyone will not ping");
  }
  const sent = await channel.send({ content: "@everyone", allowedMentions: { parse: ["everyone"] }, ...payload });
  const value = JSON.stringify({ channelId: channel.id, messageId: sent.id });
  await prisma.botSetting.upsert({ where: { key: SETTING_KEY }, create: { key: SETTING_KEY, value }, update: { value } });
  logger.info({ message: sent.id, channel: channel.id }, "Tenure announcement posted");
  return "posted";
}
