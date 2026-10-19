import { AuditLogEvent, Events } from "discord.js";
import { logEmbed, postLog } from "../lib/log.js";
import { syncMemberProfileFromRoles } from "../lib/membership.js";
import { logger } from "../core/logger.js";
export function registerLogging(client) {
    client.on(Events.GuildMemberAdd, async (member) => {
        await postLog(member.guild, "member-events", logEmbed("Member joined", 0x57f287)
            .setDescription(`<@${member.id}> (${member.user.tag})`)
            .setThumbnail(member.user.displayAvatarURL()));
    });
    client.on(Events.GuildMemberRemove, async (member) => {
        if (!member.guild)
            return;
        await postLog(member.guild, "member-events", logEmbed("Member left", 0xed4245).setDescription(`<@${member.id}> (${member.user?.tag ?? "unknown"})`));
    });
    client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
        // A partial oldMember (common right after a restart, before the member
        // cache refills) has no reliable previous nickname/roles, so we can't emit
        // the diff-based logs below. But we must NOT skip the profile sync: a role
        // edit that lands while oldMember is partial would otherwise never reach the
        // DB, leaving the member stale (e.g. routed to #general instead of their
        // module chat). syncMemberProfileFromRoles reconciles from newMember's
        // CURRENT roles and needs no diff, so run it regardless.
        if (oldMember.partial) {
            await syncMemberProfileFromRoles(newMember).catch((err) => logger.warn({ err, user: newMember.id }, "Profile sync from roles failed (partial)"));
            return;
        }
        if (oldMember.nickname !== newMember.nickname) {
            await postLog(newMember.guild, "member-events", logEmbed("Nickname change").setDescription(`<@${newMember.id}>: \`${oldMember.nickname ?? "—"}\` → \`${newMember.nickname ?? "—"}\``));
        }
        const oldRoles = new Set(oldMember.roles.cache.keys());
        const newRoles = new Set(newMember.roles.cache.keys());
        const added = [...newRoles].filter((id) => !oldRoles.has(id));
        const removed = [...oldRoles].filter((id) => !newRoles.has(id));
        if (added.length || removed.length) {
            const fmt = (ids) => ids.map((id) => `<@&${id}>`).join(", ") || "—";
            await postLog(newMember.guild, "audit", logEmbed("Roles changed").setDescription(`<@${newMember.id}>`).addFields({ name: "Added", value: fmt(added) }, { name: "Removed", value: fmt(removed) }));
            // Keep the stored profile (batch/project/module/pod) in step when a
            // Manager changes membership by editing roles directly, so downstream
            // routing (leave handovers, dashboards, reports) follows the real project.
            await syncMemberProfileFromRoles(newMember).catch((err) => logger.warn({ err, user: newMember.id }, "Profile sync from roles failed"));
        }
    });
    client.on(Events.MessageDelete, async (message) => {
        if (!message.guild || !message.author || message.author.bot)
            return;
        await postLog(message.guild, "audit", logEmbed("Message deleted", 0xed4245)
            .setDescription(`In <#${message.channelId}>`)
            .addFields({ name: "Author", value: `<@${message.author.id}>` }, { name: "Content", value: (message.content || "—").slice(0, 1000) }));
    });
    client.on(Events.MessageUpdate, async (oldMsg, newMsg) => {
        if (!newMsg.guild || !newMsg.author || newMsg.author.bot)
            return;
        if (oldMsg.content === newMsg.content)
            return;
        await postLog(newMsg.guild, "audit", logEmbed("Message edited")
            .setDescription(`In <#${newMsg.channelId}> by <@${newMsg.author.id}>`)
            .addFields({ name: "Before", value: (oldMsg.content || "—").slice(0, 500) }, { name: "After", value: (newMsg.content || "—").slice(0, 500) }));
    });
    client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
        const guild = newState.guild;
        const userId = newState.id;
        if (!oldState.channelId && newState.channelId) {
            await postLog(guild, "voice-events", logEmbed("Voice join", 0x57f287).setDescription(`<@${userId}> → <#${newState.channelId}>`));
        }
        else if (oldState.channelId && !newState.channelId) {
            await postLog(guild, "voice-events", logEmbed("Voice leave", 0xed4245).setDescription(`<@${userId}> ← <#${oldState.channelId}>`));
        }
        else if (oldState.channelId &&
            newState.channelId &&
            oldState.channelId !== newState.channelId) {
            await postLog(guild, "voice-events", logEmbed("Voice move").setDescription(`<@${userId}>: <#${oldState.channelId}> → <#${newState.channelId}>`));
        }
    });
    client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
        if (entry.action === AuditLogEvent.MemberKick ||
            entry.action === AuditLogEvent.MemberBanAdd) {
            const action = entry.action === AuditLogEvent.MemberKick ? "Kick" : "Ban";
            await postLog(guild, "moderation", logEmbed(`${action} (audit)`, 0xed4245).addFields({ name: "Target", value: entry.targetId ? `<@${entry.targetId}>` : "—" }, { name: "Executor", value: entry.executorId ? `<@${entry.executorId}>` : "—" }, { name: "Reason", value: entry.reason ?? "—" }));
        }
    });
}
//# sourceMappingURL=logging.js.map