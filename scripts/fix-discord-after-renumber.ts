/**
 * Bring Discord back in line after `npm run db:renumber`.
 *
 *   npm run db:renumber:discord            # dry run
 *   npm run db:renumber:discord -- --apply
 *
 * Renumbering moves ids that Discord has baked into two places:
 *
 *  1. Channel names — `ticket-30002`, `leave-60002`.
 *  2. Button custom ids — a pending leave's Approve button carries
 *     `leave:approve:<id>`. Left alone, HR would click Approve and be told
 *     "Already decided or not found", because that id no longer exists.
 *
 * So each affected channel is renamed, and every pending leave gets a fresh
 * approval card. The stale card's buttons are stripped rather than deleted, so
 * the conversation history stays intact but nothing broken remains clickable.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Events,
  type TextChannel,
} from "discord.js";
import { readFileSync } from "node:fs";
import { env } from "../src/config/env.js";
import { createClient } from "../src/core/client.js";
import { prisma } from "../src/core/db.js";
import { LEAVE_IDS, LEAVE_TYPES, type LeaveType } from "../src/services/leave.js";
import { formatInTz } from "../src/lib/time.js";

const APPLY = process.argv.includes("--apply");
type Mapping = { table: string; moves: { from: number; to: number }[] };
const mappings: Mapping[] = JSON.parse(readFileSync("renumber-map.json", "utf8"));
const movesFor = (t: string) => mappings.find((m) => m.table === t)?.moves ?? [];

const client = createClient();

client.once(Events.ClientReady, async (c) => {
  const guild = await (await c.guilds.fetch(env.DISCORD_GUILD_ID)).fetch();
  let renamed = 0;
  let reposted = 0;
  let skipped = 0;

  async function rename(channelId: string | null, want: string): Promise<void> {
    if (!channelId) return;
    const ch = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
    if (!ch || ch.type !== ChannelType.GuildText) {
      console.log(`   channel ${channelId} gone — skipping (${want})`);
      skipped++;
      return;
    }
    if (ch.name === want) return;
    console.log(`   ${ch.name} -> ${want}`);
    if (APPLY) await (ch as TextChannel).setName(want, "Id renumbering");
    renamed++;
  }

  // Tickets: name only.
  for (const { to } of movesFor("ticket")) {
    const row = await prisma.ticket.findUnique({ where: { id: to }, select: { channelId: true, status: true } });
    if (!row?.channelId || row.status === "closed") continue;
    await rename(row.channelId, `ticket-${to}`);
  }

  // Leaves: name, plus a working approval card for anything still pending.
  for (const { to } of movesFor("leaveRequest")) {
    const row = await prisma.leaveRequest.findUnique({ where: { id: to } });
    if (!row?.channelId) continue;
    await rename(row.channelId, `leave-${to}`);
    if (row.status !== "pending") continue;

    const ch =
      guild.channels.cache.get(row.channelId) ??
      (await guild.channels.fetch(row.channelId).catch(() => null));
    if (!ch || ch.type !== ChannelType.GuildText) continue;
    const channel = ch as TextChannel;

    // Strip buttons off the stale card so nothing broken stays clickable.
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    const stale = recent?.filter(
      (m) =>
        m.author.id === c.user.id &&
        m.components.length > 0 &&
        JSON.stringify(m.components).includes(`${LEAVE_IDS.approve}:`)
    );
    for (const m of stale?.values() ?? []) {
      console.log(`   stripping stale buttons in #${channel.name} (message ${m.id})`);
      if (APPLY) await m.edit({ components: [] }).catch(() => {});
    }

    const def = LEAVE_TYPES[row.type as LeaveType];
    const embed = new EmbedBuilder()
      .setTitle(`Leave Request #${row.id} · ${def?.label ?? row.type}`)
      .setColor(0xfaa61a)
      .addFields(
        { name: "Member", value: `<@${row.userId}>`, inline: true },
        { name: "From", value: formatInTz(row.startAt), inline: true },
        { name: "To", value: formatInTz(row.endAt), inline: true },
        { name: "Reason", value: row.reason.slice(0, 1000) }
      )
      .setFooter({ text: "HR: approve or reject below" })
      .setTimestamp(new Date());
    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${LEAVE_IDS.approve}:${row.id}`).setLabel("Approve").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${LEAVE_IDS.reject}:${row.id}`).setLabel("Reject").setStyle(ButtonStyle.Danger)
    );
    console.log(`   reposting approval card in #${channel.name} for leave #${row.id}`);
    if (APPLY) {
      await channel.send({
        content: "This request was renumbered; use the buttons below.",
        embeds: [embed],
        components: [buttons],
      });
    }
    reposted++;
  }

  console.log(
    `\n${APPLY ? "Applied" : "DRY RUN"} — renamed ${renamed}, reposted ${reposted}, skipped ${skipped}`
  );
  await prisma.$disconnect();
  await client.destroy();
  process.exit(0);
});

await client.login(env.DISCORD_TOKEN);
