import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  CategoryChannel,
  ChannelType,
  Client,
  EmbedBuilder,
  Guild,
  GuildMember,
  ModalBuilder,
  OverwriteResolvable,
  OverwriteType,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { prisma } from "../core/db.js";
import { org } from "../config/loader.js";
import { logEmbed, postLog } from "../lib/log.js";
import { logger } from "../core/logger.js";
import { isFounder } from "../lib/rbac.js";

import { ticketTypeToOffice } from "./meeting.js";
import { baseTicketsCategory, pruneEmptyOverflow, ticketsCategoryWithRoom } from "./ticketCategory.js";

export const TICKET_IDS = {
  open: "ticket:open",
  openproject: "ticket:openproject", // direct project-support entry
  talkManager: "ticket:talk:manager", // direct Manager meeting ticket
  talkHr: "ticket:talk:hr", // direct HR meeting ticket
  type: "ticket:type",
  modal: "ticket:modal", // ticket:modal:<typeKey>
  claim: "ticket:claim", // ticket:claim:<id>
  close: "ticket:close", // ticket:close:<id>
  reopen: "ticket:reopen", // ticket:reopen:<id>
  vcgrant: "ticket:vcgrant", // ticket:vcgrant:<id>
} as const;

/** How long a closed ticket stays archived (reopenable) before deletion. */
export const ARCHIVE_TTL_MS = 8 * 3600_000;

export interface TicketType {
  key: string;
  label: string;
  emoji: string;
  // admin role names that get access to this ticket type
  staffRoles: string[];
}

export const TICKET_TYPES: TicketType[] = [
  { key: "hr-help", label: "HR Help", emoji: "🧑‍💼", staffRoles: ["HR", "Founder"] },
  { key: "technical", label: "Technical Issue", emoji: "🛠️", staffRoles: ["Manager", "Founder"] },
  { key: "project", label: "Project Support", emoji: "📁", staffRoles: ["Team Lead", "Manager", "Founder"] },
  { key: "meeting", label: "Manager Meeting", emoji: "📅", staffRoles: ["Manager", "Founder"] },
  { key: "general", label: "General Question", emoji: "❓", staffRoles: ["HR", "Manager", "Founder"] },
];

export function findTicketType(key: string): TicketType | undefined {
  return TICKET_TYPES.find((t) => t.key === key);
}

export function panelEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Support Tickets")
    .setDescription(
      "Need help? Click **Open a Ticket** below and pick a category. A private channel will be created for you and the relevant staff."
    )
    .setColor(0x5865f2);
}

export function panelButton() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_IDS.open)
      .setLabel("Open a Ticket")
      .setEmoji("🎫")
      .setStyle(ButtonStyle.Primary)
  );
}

export function projectPanelEmbed(projectName: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`${projectName} Support`)
    .setDescription(
      "Need help with this project? Click **Open Support Ticket**. A private channel will be created for you, your Team Lead, and a Manager."
    )
    .setColor(0x9b59b6);
}

export function projectPanelButton(projectKey: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${TICKET_IDS.openproject}:${projectKey}`)
      .setLabel("Open Support Ticket")
      .setEmoji("📁")
      .setStyle(ButtonStyle.Primary)
  );
}

export function staffTalkPanelEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Speak with Manager or HR")
    .setDescription(
      "Use the buttons below to open a private ticket with a Manager or with HR.\n\n" +
        "1. Click the appropriate button.\n" +
        "2. Describe your query in the private channel that is created.\n" +
        "3. Staff will grant voice access if a call is needed.\n\n" +
        "Available Mon to Fri, 9:00 AM to 6:00 PM IST. Tickets are confidential and logged."
    )
    .setColor(0x5865f2);
}

export function staffTalkPanelButtons() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_IDS.talkManager)
      .setLabel("Talk to Manager")
      .setEmoji("📘")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(TICKET_IDS.talkHr)
      .setLabel("Talk to HR")
      .setEmoji("📗")
      .setStyle(ButtonStyle.Success)
  );
}

export function typeSelect() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(TICKET_IDS.type)
    .setPlaceholder("Select a ticket category")
    .addOptions(
      TICKET_TYPES.map((t) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(t.label)
          .setEmoji(t.emoji)
          .setValue(t.key)
      )
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export function detailsModal(typeKey: string, extra?: string): ModalBuilder {
  const id = extra
    ? `${TICKET_IDS.modal}:${typeKey}:${extra}`
    : `${TICKET_IDS.modal}:${typeKey}`;
  const modal = new ModalBuilder().setCustomId(id).setTitle("Open a Ticket");

  const subject = new TextInputBuilder()
    .setCustomId("subject")
    .setLabel("Subject")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  const details = new TextInputBuilder()
    .setCustomId("details")
    .setLabel("Describe your issue")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1500);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(subject),
    new ActionRowBuilder<TextInputBuilder>().addComponents(details)
  );
  return modal;
}

/** A TICKETS category with a free slot (overflow categories are created as needed). */
async function ticketsCategory(guild: Guild): Promise<CategoryChannel | undefined> {
  return (await ticketsCategoryWithRoom(guild)) ?? baseTicketsCategory(guild);
}

function archiveCategory(guild: Guild): CategoryChannel | undefined {
  return guild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildCategory &&
      c.name === org.categories.archive.name
  ) as CategoryChannel | undefined;
}

function reopenRow(ticketId: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${TICKET_IDS.reopen}:${ticketId}`)
      .setLabel("Reopen")
      .setEmoji("♻️")
      .setStyle(ButtonStyle.Success)
  );
}

/** A member may reopen only if they hold one of the roles still granted view on the archived channel. */
export function canReopenTicket(channel: TextChannel, member: GuildMember): boolean {
  if (isFounder(member)) return true;
  const roleIds = channel.permissionOverwrites.cache
    .filter(
      (ow) => ow.type === OverwriteType.Role && ow.allow.has(PermissionFlagsBits.ViewChannel)
    )
    .map((ow) => ow.id);
  return member.roles.cache.some((r) => roleIds.includes(r.id));
}

function controlRow(ticketId: number, typeKey: string) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${TICKET_IDS.claim}:${ticketId}`)
      .setLabel("Claim")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${TICKET_IDS.close}:${ticketId}`)
      .setLabel("Close")
      .setStyle(ButtonStyle.Danger)
  );
  if (ticketTypeToOffice(typeKey)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${TICKET_IDS.vcgrant}:${ticketId}`)
        .setLabel("Grant VC (30m)")
        .setEmoji("🔊")
        .setStyle(ButtonStyle.Secondary)
    );
  }
  return row;
}

export const MAX_OPEN_TICKETS_PER_USER = 3;

export async function createTicket(
  guild: Guild,
  opener: GuildMember,
  type: TicketType,
  subject: string,
  details: string,
  staffRoleOverride?: string[]
): Promise<{ channelId: string; ticketId: number }> {
  const category = await ticketsCategory(guild);
  if (!category) throw new Error("TICKETS category missing. Run /setup.");

  // Anti-spam: cap how many tickets one person can have open at once.
  const openCount = await prisma.ticket.count({
    where: {
      guildId: guild.id,
      openerId: opener.id,
      status: { in: ["open", "claimed"] },
    },
  });
  if (openCount >= MAX_OPEN_TICKETS_PER_USER) {
    throw new Error(
      `You already have ${openCount} open ticket(s). Please close one before opening another.`
    );
  }

  const staffRoles = staffRoleOverride ?? type.staffRoles;

  const row = await prisma.ticket.create({
    data: {
      guildId: guild.id,
      type: type.key,
      subject,
      openerId: opener.id,
      status: "open",
    },
  });

  const overwrites: OverwriteResolvable[] = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: opener.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];
  for (const roleName of staffRoles) {
    const role = guild.roles.cache.find((r) => r.name === roleName);
    if (role)
      overwrites.push({
        id: role.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageMessages,
        ],
      });
  }

  const channel = await guild.channels.create({
    name: `ticket-${row.id}`,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: overwrites,
    topic: `Ticket #${row.id} · ${type.label} · opener ${opener.id}`,
  });

  await prisma.ticket.update({
    where: { id: row.id },
    data: { channelId: channel.id },
  });

  const embed = new EmbedBuilder()
    .setTitle(`Ticket #${row.id} · ${type.label}`)
    .setColor(0x5865f2)
    .addFields(
      { name: "Subject", value: subject },
      { name: "Details", value: details.slice(0, 1024) },
      { name: "Opened by", value: `<@${opener.id}>` }
    )
    .setTimestamp(new Date());

  const staffMention = staffRoles
    .map((n) => guild.roles.cache.find((r) => r.name === n))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map((r) => `<@&${r.id}>`)
    .join(" ");

  await channel.send({
    content: `<@${opener.id}> ${staffMention}`,
    embeds: [embed],
    components: [controlRow(row.id, type.key)],
  });

  await postLog(
    guild,
    "tickets",
    logEmbed("Ticket opened", 0x57f287)
      .setDescription(`#${row.id} · ${type.label} · <#${channel.id}>`)
      .addFields({ name: "Opener", value: `<@${opener.id}>` })
  );

  logger.info({ ticket: row.id, type: type.key }, "Ticket created");
  return { channelId: channel.id, ticketId: row.id };
}

export async function claimTicket(
  guild: Guild,
  ticketId: number,
  staff: GuildMember
): Promise<void> {
  await prisma.ticket.update({
    where: { id: ticketId },
    data: { status: "claimed", claimedById: staff.id },
  });
  await postLog(
    guild,
    "tickets",
    logEmbed("Ticket claimed", 0xfaa61a)
      .setDescription(`#${ticketId}`)
      .addFields({ name: "Staff", value: `<@${staff.id}>` })
  );
}

async function buildTranscript(channel: TextChannel): Promise<string> {
  const messages = await channel.messages.fetch({ limit: 100 });
  const lines = Array.from(messages.values())
    .reverse()
    .map((m) => {
      const time = m.createdAt.toISOString();
      const content = m.content || (m.embeds.length ? "[embed]" : "[no content]");
      return `[${time}] ${m.author.tag}: ${content}`;
    });
  return lines.join("\n");
}

export async function closeTicket(
  guild: Guild,
  ticketId: number,
  closedBy: GuildMember
): Promise<void> {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new Error(`Ticket #${ticketId} not found`);
  if (ticket.status === "closed") throw new Error("Already closed.");

  const channel = ticket.channelId
    ? (guild.channels.cache.get(ticket.channelId) as TextChannel | undefined)
    : undefined;

  let transcript = "(channel unavailable)";
  if (channel) transcript = await buildTranscript(channel);

  await prisma.ticket.update({
    where: { id: ticketId },
    data: { status: "closed", closedAt: new Date(), closedById: closedBy.id },
  });

  const buffer = Buffer.from(
    `Ticket #${ticketId} · ${ticket.type} · ${ticket.subject}\nOpened by ${ticket.openerId}\nClosed by ${closedBy.user.tag}\n\n${transcript}`,
    "utf-8"
  );

  await postLog(
    guild,
    "tickets",
    logEmbed("Ticket closed", 0xed4245)
      .setDescription(`#${ticketId} · ${ticket.subject}`)
      .addFields({ name: "Closed by", value: `<@${closedBy.id}>` })
  );

  // attach transcript to the tickets log channel
  const logsCat = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === org.categories.logs.name
  );
  const ticketLog = guild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildText &&
      c.name === "tickets" &&
      c.parentId === logsCat?.id
  ) as TextChannel | undefined;
  if (ticketLog) {
    await ticketLog
      .send({ files: [{ attachment: buffer, name: `ticket-${ticketId}.txt` }] })
      .catch(() => {});
  }

  if (channel) {
    // Move to ARCHIVE and strip the opener's access so only the ticket's staff
    // roles can see it. Keep it reopenable for 8 hours; the sweep deletes it after.
    const archiveCat = archiveCategory(guild);
    await channel.permissionOverwrites.delete(ticket.openerId).catch(() => {});
    if (archiveCat)
      await channel.setParent(archiveCat.id, { lockPermissions: false }).catch(() => {});
    await channel
      .send({
        content:
          "Ticket closed and moved to archive. Staff can reopen it within 8 hours; after that it is deleted automatically.",
        components: [reopenRow(ticketId)],
      })
      .catch(() => {});
  }
}

/** Reopen an archived ticket: restore opener access, move back to TICKETS, mark open. */
export async function reopenTicket(
  guild: Guild,
  ticketId: number,
  staff: GuildMember
): Promise<void> {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new Error(`Ticket #${ticketId} not found`);
  if (ticket.status !== "closed") throw new Error("Ticket is not closed.");

  const channel = ticket.channelId
    ? (guild.channels.cache.get(ticket.channelId) as TextChannel | undefined)
    : undefined;
  if (!channel) throw new Error("Archived channel no longer exists.");

  await channel.permissionOverwrites.edit(ticket.openerId, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
  });
  const category = await ticketsCategory(guild);
  if (category)
    await channel.setParent(category.id, { lockPermissions: false }).catch(() => {});

  await prisma.ticket.update({
    where: { id: ticketId },
    data: { status: "open", closedAt: null, closedById: null },
  });

  await channel
    .send({
      content: `<@${ticket.openerId}> Ticket reopened by <@${staff.id}>.`,
      components: [controlRow(ticketId, ticket.type)],
    })
    .catch(() => {});

  await postLog(
    guild,
    "tickets",
    logEmbed("Ticket reopened", 0x57f287)
      .setDescription(`#${ticketId} · ${ticket.subject}`)
      .addFields({ name: "Reopened by", value: `<@${staff.id}>` })
  );
  logger.info({ ticket: ticketId }, "Ticket reopened");
}

let archiveSweepTimer: NodeJS.Timeout | null = null;

/** Delete archived tickets whose 8-hour window has elapsed. Restart-safe (DB-driven). */
async function sweepArchivedTickets(client: Client): Promise<void> {
  const cutoff = new Date(Date.now() - ARCHIVE_TTL_MS);
  const due = await prisma.ticket.findMany({
    where: { status: "closed", closedAt: { lte: cutoff }, channelId: { not: null } },
  });
  for (const t of due) {
    const guild = client.guilds.cache.get(t.guildId);
    const channel = t.channelId ? guild?.channels.cache.get(t.channelId) : undefined;
    if (channel) {
      // Only clear channelId once the delete actually succeeded; a failed
      // delete (transient API error) keeps the row due so the next 5m sweep
      // retries instead of orphaning the channel forever.
      const deleted = await channel
        .delete("Archived ticket expired (8h)")
        .then(() => true)
        .catch(() => false);
      if (!deleted) continue;
    }
    await prisma.ticket
      .update({ where: { id: t.id }, data: { channelId: null } })
      .catch(() => {});
  }
  if (due.length > 0) logger.info({ count: due.length }, "Deleted expired archived tickets");
  // Closing tickets moves them out of TICKETS; drop overflow categories left empty.
  for (const guild of client.guilds.cache.values()) await pruneEmptyOverflow(guild).catch(() => {});
}

export function startTicketArchiveSweep(client: Client): void {
  if (archiveSweepTimer) clearInterval(archiveSweepTimer);
  archiveSweepTimer = setInterval(
    () => void sweepArchivedTickets(client).catch((err) => logger.error({ err }, "Ticket archive sweep error")),
    5 * 60_000
  );
  logger.info("Ticket archive sweep started (5m)");
  void sweepArchivedTickets(client);
}

export function stopTicketArchiveSweep(): void {
  if (archiveSweepTimer) clearInterval(archiveSweepTimer);
  archiveSweepTimer = null;
}
