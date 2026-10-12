import { ChannelType, } from "discord.js";
import { prisma } from "../core/db.js";
import { org } from "../config/loader.js";
import { logEmbed, postLog } from "../lib/log.js";
import { logger } from "../core/logger.js";
let client = null;
const timers = new Map();
export function initMeetings(c) {
    client = c;
}
export function officeVoiceName(office) {
    return office === "manager"
        ? org.categories.managerOffice.voiceChannels[0] ?? "Manager Office"
        : org.categories.hrOffice.voiceChannels[0] ?? "HR Office";
}
export function getOfficeVoiceChannel(guild, office) {
    const name = officeVoiceName(office);
    return guild.channels.cache.find((c) => c.type === ChannelType.GuildVoice && c.name === name);
}
/** If channelId is a private office VC, return which office; else null. */
export function officeOfVoiceChannel(guild, channelId) {
    const mgr = getOfficeVoiceChannel(guild, "manager");
    if (mgr && mgr.id === channelId)
        return "manager";
    const hr = getOfficeVoiceChannel(guild, "hr");
    if (hr && hr.id === channelId)
        return "hr";
    return null;
}
export function ticketTypeToOffice(typeKey) {
    if (typeKey === "meeting")
        return "manager";
    if (typeKey === "hr-help" || typeKey === "leave")
        return "hr";
    return null;
}
export async function grantVoiceAccess(guild, userId, office, minutes, grantedById) {
    const vc = getOfficeVoiceChannel(guild, office);
    if (!vc)
        throw new Error(`${officeVoiceName(office)} voice channel not found. Run /setup.`);
    await vc.permissionOverwrites.edit(userId, {
        ViewChannel: true,
        Connect: true,
        Speak: true,
    });
    const expiresAt = new Date(Date.now() + minutes * 60_000);
    const row = await prisma.voiceGrant.create({
        data: { guildId: guild.id, userId, channelId: vc.id, grantedById, expiresAt },
    });
    scheduleRevoke(row.id, guild.id, userId, vc.id, expiresAt);
    await postLog(guild, "audit", logEmbed("Voice access granted", 0x57f287)
        .setDescription(`<@${userId}> → ${vc.name} for ${minutes}m`)
        .addFields({ name: "By", value: `<@${grantedById}>` }));
    return { channelName: vc.name, expiresAt };
}
async function doRevoke(guildId, userId, channelId, grantId) {
    if (!client)
        return;
    const guild = client.guilds.cache.get(guildId);
    if (guild) {
        const vc = guild.channels.cache.get(channelId);
        if (vc && "permissionOverwrites" in vc) {
            await vc.permissionOverwrites.delete(userId, "Voice grant expired").catch(() => { });
        }
        // If still connected to that channel, disconnect
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member?.voice.channelId === channelId) {
            await member.voice.disconnect("Voice grant expired").catch(() => { });
        }
        await postLog(guild, "audit", logEmbed("Voice access revoked", 0xed4245).setDescription(`<@${userId}>`));
    }
    if (grantId !== undefined) {
        await prisma.voiceGrant
            .update({ where: { id: grantId }, data: { revoked: true } })
            .catch(() => { });
        const t = timers.get(grantId);
        if (t) {
            clearTimeout(t);
            timers.delete(grantId);
        }
    }
}
function scheduleRevoke(grantId, guildId, userId, channelId, expiresAt) {
    const delay = Math.max(0, expiresAt.getTime() - Date.now());
    // Node timers cap ~24.8 days; meetings are short so this is fine
    const t = setTimeout(() => {
        void doRevoke(guildId, userId, channelId, grantId);
    }, delay);
    timers.set(grantId, t);
}
export async function revokeNow(guild, userId, office, grantId) {
    const vc = getOfficeVoiceChannel(guild, office);
    if (vc)
        await doRevoke(guild.id, userId, vc.id, grantId);
}
/** Re-arm or expire grants after a restart. */
export async function restoreGrants() {
    const active = await prisma.voiceGrant.findMany({ where: { revoked: false } });
    for (const g of active) {
        if (g.expiresAt.getTime() <= Date.now()) {
            await doRevoke(g.guildId, g.userId, g.channelId, g.id);
        }
        else {
            scheduleRevoke(g.id, g.guildId, g.userId, g.channelId, g.expiresAt);
        }
    }
    if (active.length > 0)
        logger.info({ count: active.length }, "Restored voice grants");
}
//# sourceMappingURL=meeting.js.map