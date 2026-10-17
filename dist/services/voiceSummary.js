import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits, } from "discord.js";
import { prisma } from "../core/db.js";
import { org } from "../config/loader.js";
import { logger } from "../core/logger.js";
import { botGuild } from "../core/botClient.js";
import { shiftDayKey, tzDateKey, tzDayStartUtc } from "../lib/time.js";
import { holidayMap, isWorkingDay } from "./holidays.js";
/**
 * When a member leaves voice, tell them in their own team channel how much
 * time they have served today — no command needed. Posting waits a short delay
 * so a quick reconnect doesn't spam, replaces that member's previous summary,
 * and removes itself after a while; the member can dismiss it sooner.
 */
const DISMISS_PREFIX = "vcsum:dismiss:";
const timers = new Map();
const lastPosted = new Map();
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
export function cancelVoiceSummary(userId) {
    const t = timers.get(userId);
    if (t)
        clearTimeout(t);
    timers.delete(userId);
}
export function scheduleVoiceSummary(guildId, userId) {
    if (!org.voiceSummary.enabled)
        return;
    cancelVoiceSummary(userId);
    const t = setTimeout(() => {
        timers.delete(userId);
        void postSummary(guildId, userId).catch((err) => logger.warn({ err, userId }, "Voice summary post failed"));
    }, org.voiceSummary.delaySeconds * 1000);
    t.unref?.();
    timers.set(userId, t);
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
    const cat = guild.channels.cache.find((x) => x.type === ChannelType.GuildCategory && x.name === project.name.toUpperCase());
    const general = cat
        ? guild.channels.cache.find((x) => x.type === ChannelType.GuildText && x.parentId === cat.id && x.name === "general")
        : undefined;
    return general && canPost(general) ? general : null;
}
async function postSummary(guildId, userId) {
    const guild = botGuild(guildId);
    if (!guild)
        return;
    const discordMember = await guild.members.fetch(userId).catch(() => null);
    if (!discordMember || discordMember.user.bot)
        return;
    if (discordMember.voice.channelId)
        return; // rejoined during the delay
    const m = await prisma.member.findUnique({
        where: { id: userId },
        select: { project: true, module: true, pod: true },
    });
    if (!m?.project)
        return;
    const channel = memberChannel(guild, m);
    if (!channel)
        return;
    const p = org.attendancePolicy;
    const today = tzDateKey(new Date());
    const required = Math.round(p.minHours * 3600);
    const [row, first, holidays] = await Promise.all([
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
    ]);
    const served = row?.seconds ?? 0;
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
    else if (new Date() < windowEnd) {
        verdict = `⏳ **${hm(required - served)}** still to go today. Rejoin before ${p.windowEnd} to complete ${p.minHours}h.`;
        color = 0xfbbf24;
    }
    else {
        verdict = `⚠️ Short by **${hm(required - served)}** today. Two short days in a row lead to a formal warning.`;
        color = 0xfb7185;
    }
    const embed = new EmbedBuilder()
        .setColor(color)
        .setAuthor({ name: discordMember.displayName, iconURL: discordMember.displayAvatarURL() })
        .setTitle("Voice session ended")
        .setDescription([
        `You have served **${hm(served)}** today${working ? ` of **${hm(required)}**` : ""}.`,
        working ? `\`${bar(served / required)}\` ${Math.min(100, Math.round((served / required) * 100))}%` : null,
        firstJoin ? `First join: **${clock(today, firstJoin)}**${working ? (lateBy ? ` (late by ${lateBy} min, cutoff ${p.loginBy})` : " (on time)") : ""}` : null,
        "",
        verdict,
    ]
        .filter((l) => l !== null)
        .join("\n"))
        .setFooter({
        text: org.voiceSummary.deleteAfterMinutes > 0
            ? `Disappears in ${org.voiceSummary.deleteAfterMinutes} min · only you can dismiss it`
            : "Only you can dismiss this",
    })
        .setTimestamp(new Date());
    const row2 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${DISMISS_PREFIX}${userId}`).setLabel("Dismiss").setStyle(ButtonStyle.Secondary));
    // One live summary per member: replace the previous one.
    const prev = lastPosted.get(userId);
    if (prev) {
        const prevChannel = guild.channels.cache.get(prev.channelId);
        if (prevChannel?.isTextBased())
            await prevChannel.messages.delete(prev.messageId).catch(() => { });
    }
    const msg = await channel.send({
        content: `<@${userId}>`,
        embeds: [embed],
        components: [row2],
        allowedMentions: { users: [userId] },
    });
    lastPosted.set(userId, { channelId: channel.id, messageId: msg.id });
    const after = org.voiceSummary.deleteAfterMinutes;
    if (after > 0) {
        const t = setTimeout(() => {
            void msg.delete().catch(() => { });
            if (lastPosted.get(userId)?.messageId === msg.id)
                lastPosted.delete(userId);
        }, after * 60_000);
        t.unref?.();
    }
}
/** "Dismiss" on a summary: the member it's for (or staff who can manage messages). */
export const voiceSummaryDismissHandler = {
    id: "voice-summary-dismiss",
    matches: (i) => i.isButton() && i.customId.startsWith(DISMISS_PREFIX),
    async handle(i) {
        if (!i.isButton())
            return;
        const owner = i.customId.slice(DISMISS_PREFIX.length);
        const staff = i.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ?? false;
        if (i.user.id !== owner && !staff) {
            await i.reply({ content: "Only the member this summary is for can dismiss it.", flags: MessageFlags.Ephemeral });
            return;
        }
        await i.deferUpdate();
        await i.message.delete().catch(() => { });
        if (lastPosted.get(owner)?.messageId === i.message.id)
            lastPosted.delete(owner);
    },
};
//# sourceMappingURL=voiceSummary.js.map