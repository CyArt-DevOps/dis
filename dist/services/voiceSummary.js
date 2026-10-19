import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, } from "discord.js";
import { prisma } from "../core/db.js";
import { org, activeProjects } from "../config/loader.js";
import { logger } from "../core/logger.js";
import { shiftDayKey, tzDateKey, tzDayStartUtc } from "../lib/time.js";
import { holidayMap, isWorkingDay } from "./holidays.js";
import { pendingOpenSeconds } from "./attendance.js";
/**
 * "How many hours have I served today?", answered privately.
 *
 * Discord only allows a message visible to one person ("Only you can see
 * this") as the reply to that person's own interaction, so a summary can't be
 * pushed when someone leaves voice. Instead members ask: `/hours` anywhere, or
 * the "Check my hours" button on a panel in their project's #general. Nothing
 * is ever posted publicly and no extra channels are created.
 */
const CHECK_ID = "hours:check";
function hm(seconds) {
    const s = Math.max(0, Math.round(seconds));
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}
function localTimeOn(day, hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    return new Date(tzDayStartUtc(day).getTime() + ((h ?? 0) * 60 + (m ?? 0)) * 60_000);
}
function clock(day, at) {
    const min = Math.round((at.getTime() - tzDayStartUtc(day).getTime()) / 60_000);
    return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}
function bar(fraction) {
    const n = 12;
    const filled = Math.max(0, Math.min(n, Math.round(fraction * n)));
    return "▰".repeat(filled) + "▱".repeat(n - filled);
}
/** Most specific text channel the bot can post in: pod → module → module info → project general. */
export function memberChannel(guild, m) {
    const project = org.projects.find((p) => p.name === m.project);
    if (!project)
        return null;
    const names = [];
    if (m.module && m.pod)
        names.push(`${project.key}-m${m.module}-p${m.pod}-chat`);
    if (m.module)
        names.push(`${project.key}-m${m.module}-chat`, `${project.key}-m${m.module}-info`);
    const me = guild.members.me;
    const canPost = (c) => !me || c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
    for (const name of names) {
        const c = guild.channels.cache.find((x) => x.type === ChannelType.GuildText && x.name === name);
        if (c && canPost(c))
            return c;
    }
    const general = projectGeneral(guild, project.name);
    return general && canPost(general) ? general : null;
}
function projectGeneral(guild, projectName) {
    const cat = guild.channels.cache.find((x) => x.type === ChannelType.GuildCategory && x.name === projectName.toUpperCase());
    return cat
        ? guild.channels.cache.find((x) => x.type === ChannelType.GuildText && x.parentId === cat.id && x.name === "general")
        : undefined;
}
/** Today's voice summary for one member, including time in a session still open. */
export async function hoursEmbed(guildId, userId, who) {
    const p = org.attendancePolicy;
    const today = tzDateKey(new Date());
    const required = Math.round(p.minHours * 3600);
    const [row, first, holidays, pending, live] = await Promise.all([
        prisma.attendance.findFirst({ where: { guildId, userId, day: today }, select: { seconds: true } }),
        prisma.voiceSession.findFirst({
            where: {
                guildId,
                userId,
                joinedAt: { lt: tzDayStartUtc(shiftDayKey(today, 1)) },
                OR: [{ leftAt: null }, { leftAt: { gt: tzDayStartUtc(today) } }],
            },
            orderBy: { joinedAt: "asc" },
            select: { joinedAt: true },
        }),
        holidayMap(guildId),
        pendingOpenSeconds(guildId, userId),
        prisma.voiceSession.findFirst({ where: { guildId, userId, leftAt: null }, select: { id: true } }),
    ]);
    const served = (row?.seconds ?? 0) + (pending.get(userId)?.get(today) ?? 0);
    const firstJoin = first ? (first.joinedAt < tzDayStartUtc(today) ? tzDayStartUtc(today) : first.joinedAt) : null;
    const working = isWorkingDay(today, holidays);
    const cutoff = localTimeOn(today, p.loginBy);
    const windowEnd = localTimeOn(today, p.windowEnd);
    const lateBy = firstJoin && firstJoin > cutoff ? Math.round((firstJoin.getTime() - cutoff.getTime()) / 60_000) : 0;
    let verdict;
    let color;
    if (!working) {
        const name = holidays.get(today);
        verdict = name ? `Today is a public holiday (**${name}**), so it doesn't count.` : "Today is not a working day, so it doesn't count.";
        color = 0x71717a;
    }
    else if (served >= required) {
        verdict = lateBy ? `✅ Daily ${p.minHours}h target met, but your first join was **${lateBy} min late**.` : `✅ Daily ${p.minHours}h target met. Thank you!`;
        color = lateBy ? 0xfbbf24 : 0x34d399;
    }
    else if (!firstJoin) {
        verdict = `You haven't joined voice today. Join by **${p.loginBy}** and serve **${p.minHours}h** before ${p.windowEnd}.`;
        color = new Date() < cutoff ? 0x71717a : 0xfb7185;
    }
    else if (new Date() < windowEnd) {
        verdict = `⏳ **${hm(required - served)}** still to go today. ${live ? "Stay connected" : `Rejoin before ${p.windowEnd}`} to complete ${p.minHours}h.`;
        color = 0xfbbf24;
    }
    else {
        verdict = `⚠️ Short by **${hm(required - served)}** today. Two short days in a row lead to a formal warning.`;
        color = 0xfb7185;
    }
    return new EmbedBuilder()
        .setColor(color)
        .setAuthor({ name: who.name, iconURL: who.avatar })
        .setTitle(live ? "Your voice hours today (in voice now)" : "Your voice hours today")
        .setDescription([
        `You have served **${hm(served)}** today${working ? ` of **${hm(required)}**` : ""}.`,
        working ? `\`${bar(served / required)}\` ${Math.min(100, Math.round((served / required) * 100))}%` : null,
        firstJoin
            ? `First join: **${clock(today, firstJoin)}**${working ? (lateBy ? ` (late by ${lateBy} min, cutoff ${p.loginBy})` : " (on time)") : ""}`
            : null,
        "",
        verdict,
    ]
        .filter((l) => l !== null)
        .join("\n"))
        .setFooter({ text: "Only you can see this" })
        .setTimestamp(new Date());
}
async function replyHours(i) {
    if (!i.isRepliable() || !i.guildId)
        return;
    const name = (i.member && "displayName" in i.member ? i.member.displayName : null) ?? i.user.globalName ?? i.user.username;
    const embed = await hoursEmbed(i.guildId, i.user.id, { name, avatar: i.user.displayAvatarURL() });
    if (i.deferred || i.replied)
        await i.editReply({ embeds: [embed] });
    else
        await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
/** `/hours`: today's served time, visible only to the member who asked. */
export const hoursCommand = {
    data: new SlashCommandBuilder().setName("hours").setDescription("See how many hours you've served in voice today (only you can see it)"),
    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await replyHours(interaction);
    },
};
/** The "Check my hours" button on the #general panels. */
export const hoursButtonHandler = {
    id: "hours-check",
    ack: "reply",
    matches: (i) => i.isButton() && i.customId === CHECK_ID,
    handle: replyHours,
};
/**
 * One "Check my hours" panel in each active project's #general. Idempotent:
 * skipped where the bot's panel is already among recent messages.
 */
export async function ensureHoursPanels(guild) {
    let posted = 0;
    for (const p of activeProjects()) {
        const general = projectGeneral(guild, p.name);
        if (!general)
            continue;
        const me = guild.members.me;
        if (me && !general.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))
            continue;
        const recent = await general.messages.fetch({ limit: 50 }).catch(() => null);
        const exists = recent?.some((msg) => msg.author.id === guild.client.user.id &&
            msg.components.some((r) => "components" in r && r.components.some((c) => "customId" in c && c.customId === CHECK_ID)));
        if (exists)
            continue;
        await general
            .send({
            embeds: [
                new EmbedBuilder()
                    .setColor(0x5865f2)
                    .setTitle("Check your voice hours")
                    .setDescription(`Press the button (or type **/hours** anywhere) to see how long you've served in voice today, your first-join time and what's left of the ${org.attendancePolicy.minHours}h target.\n\nThe reply is private: only you can see it.`),
            ],
            components: [
                new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(CHECK_ID).setLabel("Check my hours").setEmoji("⏱️").setStyle(ButtonStyle.Primary)),
            ],
        })
            .then(() => {
            posted++;
        })
            .catch((err) => logger.warn({ err, project: p.key }, "Could not post hours panel"));
    }
    if (posted)
        logger.info({ posted }, "Posted Check-my-hours panels");
    return posted;
}
//# sourceMappingURL=voiceSummary.js.map