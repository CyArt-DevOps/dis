import { ChannelType, EmbedBuilder, OverwriteType, PermissionFlagsBits, } from "discord.js";
import { prisma } from "../core/db.js";
import { logger } from "../core/logger.js";
import { findProject, org } from "../config/loader.js";
import { roleNames } from "../lib/names.js";
import { getOfficeVoiceChannel, officeOfVoiceChannel } from "./meeting.js";
import { discordTimestamp, formatInTz } from "../lib/time.js";
let client = null;
let sweepTimer = null;
/** Hooks so Phase C (attendance) can plug in without touching the scheduler. */
let onMeetingStart = async () => { };
let onMeetingEnd = async () => { };
let onMeetingTick = async () => { };
export function setMeetingHooks(hooks) {
    if (hooks.onStart)
        onMeetingStart = hooks.onStart;
    if (hooks.onEnd)
        onMeetingEnd = hooks.onEnd;
    if (hooks.onTick)
        onMeetingTick = hooks.onTick;
}
export const REMINDER_OFFSETS = [
    { key: "24h", ms: 24 * 3600_000, label: "24 hours" },
    { key: "1h", ms: 3600_000, label: "1 hour" },
    { key: "15m", ms: 15 * 60_000, label: "15 minutes" },
    { key: "5m", ms: 5 * 60_000, label: "5 minutes" },
    { key: "start", ms: 0, label: "now" },
];
/** Resolve the role whose members are the meeting's required participants. */
export function resolveAudienceRole(guild, m) {
    const find = (name) => guild.roles.cache.find((r) => r.name === name);
    switch (m.audienceType) {
        case "org":
            return find(roleNames.intern());
        case "batch":
            return m.audienceBatch ? find(m.audienceBatch) : undefined;
        case "project": {
            const p = m.audienceProject ? findProject(m.audienceProject) : undefined;
            return p ? find(roleNames.project(p)) : undefined;
        }
        case "module": {
            const p = m.audienceProject ? findProject(m.audienceProject) : undefined;
            return p && m.audienceModule ? find(roleNames.module(p, m.audienceModule)) : undefined;
        }
        case "pod": {
            const p = m.audienceProject ? findProject(m.audienceProject) : undefined;
            return p && m.audienceModule && m.audiencePod
                ? find(roleNames.pod(p, m.audienceModule, m.audiencePod))
                : undefined;
        }
        case "people":
            return undefined;
    }
}
export function audienceLabel(m) {
    const p = m.audienceProject ? findProject(m.audienceProject) : undefined;
    switch (m.audienceType) {
        case "org":
            return "Entire Organization";
        case "batch":
            return `Batch ${m.audienceBatch}`;
        case "project":
            return p?.name ?? m.audienceProject ?? "Project";
        case "module":
            return p && m.audienceModule
                ? roleNames.module(p, m.audienceModule)
                : `Module ${m.audienceModule}`;
        case "pod":
            return p && m.audienceModule && m.audiencePod
                ? roleNames.pod(p, m.audienceModule, m.audiencePod)
                : `Module ${m.audienceModule} Pod ${m.audiencePod}`;
        case "people": {
            const count = m.audienceMemberIds
                ? m.audienceMemberIds.split(",").filter(Boolean).length
                : 0;
            return `Specific people (${count})`;
        }
    }
}
export async function scheduleMeeting(args) {
    let meeting = await prisma.meeting.create({
        data: {
            guildId: args.guild.id,
            title: args.title,
            description: args.description,
            organizerId: args.organizerId,
            startAt: args.startAt,
            durationMin: args.durationMin,
            audienceType: args.audienceType,
            audienceBatch: args.audienceBatch,
            audienceProject: args.audienceProject,
            audienceModule: args.audienceModule,
            audiencePod: args.audiencePod,
            audienceMemberIds: args.audienceMemberIds,
            office: args.office,
            voiceChannelId: args.voiceChannelId,
            mandatory: args.mandatory,
            attendanceWindowMin: args.attendanceWindowMin,
            reminderIntervalMin: args.reminderIntervalMin,
        },
    });
    logger.info({ meeting: meeting.id, title: meeting.title }, "Meeting scheduled");
    // Named-people meetings can't be DM'd (bot anti-spam limits). Create a private
    // channel that only the invited people + staff can see; all notifications land there.
    if (meeting.audienceType === "people") {
        const ch = await createPeopleMeetingChannel(args.guild, meeting);
        if (ch)
            meeting = { ...meeting, notifyChannelId: ch.id };
    }
    await sendNotification(args.guild, meeting, "scheduled").catch((err) => logger.warn({ err, meeting: meeting.id }, "Scheduled notification failed"));
    return meeting;
}
/**
 * Re-send the "scheduled" notification for an existing meeting to its correct
 * channel (e.g. after a routing fix, or if the original post was missed).
 * Returns the resolved target channel name for the caller to report.
 */
export async function renotifyMeeting(guild, m) {
    const delivered = await sendNotification(guild, m, "scheduled");
    if (!delivered) {
        throw new Error("Discord did not accept the message (network/permissions). Check bot logs.");
    }
    if (m.audienceType === "people")
        return m.notifyChannelId ? `<#${m.notifyChannelId}>` : "meeting channel";
    const ch = resolveNotificationChannel(guild, m);
    if (ch)
        return `<#${ch.id}>`;
    return `<#${m.voiceChannelId}> (voice chat fallback)`;
}
/** Private `meeting-<id>` channel under TICKETS: invited people read-only, staff can post. */
async function createPeopleMeetingChannel(guild, m) {
    const ids = (m.audienceMemberIds ?? "").split(",").filter(Boolean);
    const V = PermissionFlagsBits.ViewChannel;
    const S = PermissionFlagsBits.SendMessages;
    const R = PermissionFlagsBits.ReadMessageHistory;
    const MG = PermissionFlagsBits.ManageMessages;
    const staffIds = ["Founder", "Manager", "HR"]
        .map((n) => guild.roles.cache.find((r) => r.name === n)?.id)
        .filter((x) => !!x);
    const ticketsCat = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === org.categories.tickets.name);
    const overwrites = [
        { id: guild.roles.everyone.id, deny: [V] },
        ...ids.map((id) => ({ id, allow: [V, R] })), // invited: read-only
        ...staffIds.map((id) => ({ id, allow: [V, S, R, MG] })),
    ];
    try {
        const channel = await guild.channels.create({
            name: `meeting-${m.id}`,
            type: ChannelType.GuildText,
            parent: ticketsCat?.id,
            permissionOverwrites: overwrites,
            topic: `Meeting #${m.id} · ${m.title}`,
        });
        await prisma.meeting.update({ where: { id: m.id }, data: { notifyChannelId: channel.id } });
        return channel;
    }
    catch (err) {
        logger.warn({ err, meeting: m.id }, "Could not create meeting notification channel");
        return null;
    }
}
/** Delete a people-meeting's private notification channel, if present. */
async function deletePeopleMeetingChannel(guild, m, reason) {
    if (!m.notifyChannelId)
        return;
    const ch = guild.channels.cache.get(m.notifyChannelId) ??
        (await guild.channels.fetch(m.notifyChannelId).catch(() => null));
    await ch?.delete(reason).catch(() => { });
}
export async function cancelMeeting(meetingId) {
    const m = await prisma.meeting.update({
        where: { id: meetingId },
        data: { status: "cancelled" },
    });
    if (client) {
        const guild = client.guilds.cache.get(m.guildId);
        if (guild) {
            if (m.audienceType === "people" && m.notifyChannelId) {
                await deletePeopleMeetingChannel(guild, m, "Meeting cancelled");
            }
            // If a temp office-VC grant is live (meeting was monitoring), pull it now.
            await revokeAudienceVoiceAccess(guild, m).catch((err) => logger.warn({ err, meeting: m.id }, "Cancel: VC revoke failed"));
        }
    }
}
/** Exposed so attendance can clean up the private channel when a meeting ends. */
export async function cleanupPeopleMeetingChannel(guild, m) {
    if (m.audienceType !== "people")
        return;
    await deletePeopleMeetingChannel(guild, m, "Meeting ended");
}
/**
 * Role-based meeting whose VC is a private office (HR/Manager): grant the
 * audience *role* temporary View+Connect+Speak so members can join for the
 * meeting. A single role overwrite scales to any audience size (per-user
 * overwrites would hit Discord's ~500/channel limit). Scoped to office VCs so
 * we never clobber a project/pod VC's existing role overwrites. No-op for
 * public VCs (members can already join) and for "people" meetings (those grant
 * per-user access instead).
 */
export async function grantAudienceVoiceAccess(guild, m) {
    if (m.audienceType === "people")
        return;
    if (!officeOfVoiceChannel(guild, m.voiceChannelId))
        return;
    const role = resolveAudienceRole(guild, m);
    const vc = guild.channels.cache.get(m.voiceChannelId);
    if (!role || !vc || !("permissionOverwrites" in vc))
        return;
    // Idempotence guard: overwrite already grants Connect → nothing to do. This
    // makes the function safe to call every attendance tick as a retry for a
    // grant that failed at meeting start (e.g. transient API timeout).
    const existing = vc.permissionOverwrites.cache.get(role.id);
    if (existing?.allow.has(PermissionFlagsBits.Connect))
        return;
    await vc.permissionOverwrites
        .edit(role.id, { ViewChannel: true, Connect: true, Speak: true })
        .then(() => logger.info({ meeting: m.id, role: role.name, vc: vc.name }, "Granted audience role temp VC access"))
        .catch((err) => logger.warn({ err, meeting: m.id }, "Audience role VC grant failed"));
}
/**
 * Remove the temporary office-VC access granted by grantAudienceVoiceAccess and
 * disconnect any non-staff members still connected, so the office is private
 * again the moment the meeting ends.
 */
export async function revokeAudienceVoiceAccess(guild, m) {
    if (m.audienceType === "people")
        return;
    if (!officeOfVoiceChannel(guild, m.voiceChannelId))
        return;
    const role = resolveAudienceRole(guild, m);
    const vc = guild.channels.cache.get(m.voiceChannelId);
    if (!vc || !("permissionOverwrites" in vc))
        return;
    if (role) {
        await vc.permissionOverwrites
            .delete(role.id, "Meeting ended — revoke temp VC access")
            .catch((err) => logger.warn({ err, meeting: m.id }, "Audience role VC revoke failed"));
    }
    // Kick out anyone still in the office VC who isn't staff — access is gone.
    const staff = new Set(org.roles.admin);
    if (vc.type === ChannelType.GuildVoice || vc.type === ChannelType.GuildStageVoice) {
        for (const mem of vc.members.values()) {
            if (mem.user.bot)
                continue;
            if (mem.roles.cache.some((r) => staff.has(r.name)))
                continue;
            await mem.voice.disconnect("Meeting ended").catch(() => { });
        }
    }
    logger.info({ meeting: m.id, vc: vc.name }, "Revoked audience role temp VC access");
}
function reminderEmbed(m, label, audience) {
    const title = label === "scheduled"
        ? `Meeting scheduled: ${m.title}`
        : label === "now"
            ? `Meeting starting now: ${m.title}`
            : `Meeting in ${label}: ${m.title}`;
    const e = new EmbedBuilder()
        .setColor(label === "now" ? 0x57f287 : label === "scheduled" ? 0x5865f2 : 0xfaa61a)
        .setTitle(title)
        .addFields({ name: "When", value: `${formatInTz(m.startAt)} · ${discordTimestamp(m.startAt, "R")}` }, { name: "Duration", value: `${m.durationMin} min`, inline: true }, { name: "Audience", value: audience, inline: true }, { name: "Voice channel", value: `<#${m.voiceChannelId}>`, inline: true });
    if (m.description)
        e.setDescription(m.description);
    if (m.mandatory)
        e.setFooter({ text: "Mandatory — attendance is tracked." });
    return e;
}
/**
 * Where a notification for this meeting's audience should land:
 * org/batch → the global #announcements (INFORMATION category);
 * the project's #announcements, the module's #chat, or the pod's #chat.
 * Project channels reuse the plain name "announcements" per project category,
 * so lookup must be scoped to that project's category, not by name alone.
 */
function resolveNotificationChannel(guild, m) {
    // Org- and batch-wide meetings both broadcast to the global #announcements.
    if (m.audienceType === "org" || m.audienceType === "batch") {
        const infoCat = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory &&
            c.name === org.categories.information.name);
        const ch = guild.channels.cache.find((c) => c.type === ChannelType.GuildText &&
            c.name === "announcements" &&
            (infoCat ? c.parentId === infoCat.id : true));
        return ch ?? null;
    }
    const p = m.audienceProject ? findProject(m.audienceProject) : undefined;
    if (!p)
        return null;
    if (m.audienceType === "project") {
        const cat = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === p.name.toUpperCase());
        if (!cat)
            return null;
        const ch = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === "announcements" && c.parentId === cat.id);
        return ch ?? null;
    }
    if (m.audienceType === "module" && m.audienceModule) {
        // Pod-based projects use a module-wide `-info` channel; pod-less projects use
        // the module `-chat`. Prefer `-info`, fall back to `-chat`.
        const byName = (name) => guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === name);
        const ch = byName(`${p.key}-m${m.audienceModule}-info`) ??
            byName(`${p.key}-m${m.audienceModule}-chat`);
        return ch ?? null;
    }
    if (m.audienceType === "pod" && m.audienceModule && m.audiencePod) {
        const ch = guild.channels.cache.find((c) => c.type === ChannelType.GuildText &&
            c.name === `${p.key}-m${m.audienceModule}-p${m.audiencePod}-chat`);
        return ch ?? null;
    }
    return null;
}
/**
 * Send a notification (immediate "scheduled" or a timed reminder) to the right
 * place. Returns true only if a message was actually delivered — the sweep uses
 * this so a failed send (e.g. a transient Discord API timeout) is NOT marked
 * "sent" and gets retried on the next pass instead of being lost.
 */
async function sendNotification(guild, m, label) {
    const embed = reminderEmbed(m, label, audienceLabel(m));
    if (m.audienceType === "people") {
        if (!m.notifyChannelId) {
            logger.warn({ meeting: m.id }, "No notify channel for people meeting — cannot notify");
            return false;
        }
        const channel = guild.channels.cache.get(m.notifyChannelId) ??
            (await guild.channels.fetch(m.notifyChannelId).catch(() => null));
        if (channel && channel.isTextBased()) {
            const ids = (m.audienceMemberIds ?? "").split(",").filter(Boolean);
            const mention = ids.map((id) => `<@${id}>`).join(" ");
            try {
                await channel.send({ content: mention, embeds: [embed] });
                return true;
            }
            catch (err) {
                logger.warn({ err, meeting: m.id }, "People notification failed");
                return false;
            }
        }
        return false;
    }
    if (m.audienceType === "org" ||
        m.audienceType === "batch" ||
        m.audienceType === "project" ||
        m.audienceType === "module" ||
        m.audienceType === "pod") {
        const channel = resolveNotificationChannel(guild, m);
        if (channel) {
            const role = resolveAudienceRole(guild, m);
            const mention = role ? `<@&${role.id}>` : "";
            try {
                await channel.send({ content: mention, embeds: [embed] });
                return true;
            }
            catch (err) {
                logger.warn({ err, meeting: m.id }, "Notification send failed");
                return false;
            }
        }
        // Fall through to the voice-channel chat if the target channel wasn't found.
    }
    const role = resolveAudienceRole(guild, m);
    const vc = guild.channels.cache.get(m.voiceChannelId);
    const target = vc && (vc.type === ChannelType.GuildVoice || vc.type === ChannelType.GuildStageVoice)
        ? vc
        : null;
    const mention = role ? `<@&${role.id}>` : "";
    if (target && "send" in target) {
        try {
            await target.send({
                content: mention,
                embeds: [embed],
            });
            return true;
        }
        catch (err) {
            logger.warn({ err, meeting: m.id }, "Reminder send failed");
            return false;
        }
    }
    return false;
}
/**
 * Persist the full sent-set. The set (not a per-key append) is the source of
 * truth: appending from a stale snapshot dropped earlier keys when two offsets
 * fired in the same sweep, causing duplicate reminders on the next pass.
 */
async function persistRemindersSent(meetingId, sent) {
    await prisma.meeting.update({
        where: { id: meetingId },
        data: { remindersSent: Array.from(sent).join(",") },
    });
}
/**
 * Self-healing pass, run each sweep:
 * 1. Office VCs: remove audience-role overwrites left behind when a meeting-end
 *    revoke failed (API timeout, bot crash mid-meeting). Skipped entirely for a
 *    VC any scheduled/monitoring meeting targets, so live grants are never touched.
 *    Admin-role and @everyone overwrites (bootstrap design) are always preserved;
 *    member overwrites belong to the voiceGrant system and are never touched.
 * 2. Orphaned `meeting-<id>` text channels (people meetings) whose meeting is no
 *    longer active — left behind when the end-of-meeting delete failed.
 */
async function cleanupMeetingOrphans(active) {
    if (!client)
        return;
    const activeVcIds = new Set(active.map((m) => m.voiceChannelId));
    const activeIds = new Set(active.map((m) => m.id));
    const staff = new Set(org.roles.admin);
    for (const guild of client.guilds.cache.values()) {
        for (const office of ["manager", "hr"]) {
            const vc = getOfficeVoiceChannel(guild, office);
            if (!vc || activeVcIds.has(vc.id))
                continue;
            for (const ow of vc.permissionOverwrites.cache.values()) {
                if (ow.type !== OverwriteType.Role)
                    continue;
                if (ow.id === guild.roles.everyone.id)
                    continue;
                const role = guild.roles.cache.get(ow.id);
                if (role && staff.has(role.name))
                    continue;
                await vc.permissionOverwrites
                    .delete(ow.id, "Orphaned meeting VC access cleanup")
                    .then(() => logger.info({ vc: vc.name, role: role?.name ?? ow.id }, "Removed orphaned office VC role overwrite"))
                    .catch(() => { }); // retried next sweep
            }
        }
        for (const ch of guild.channels.cache.values()) {
            if (ch.type !== ChannelType.GuildText)
                continue;
            const match = ch.name.match(/^meeting-(\d+)$/);
            if (!match)
                continue;
            if (activeIds.has(Number(match[1])))
                continue;
            await ch
                .delete("Orphaned meeting channel cleanup")
                .then(() => logger.info({ channel: ch.name }, "Deleted orphaned meeting channel"))
                .catch(() => { }); // retried next sweep
        }
    }
}
/** One sweep pass: fire due reminders, start monitoring, finalize ended meetings. */
async function sweep() {
    if (!client)
        return;
    const now = Date.now();
    const meetings = await prisma.meeting.findMany({
        where: { status: { in: ["scheduled", "monitoring"] } },
    });
    for (const m of meetings) {
        const guild = client.guilds.cache.get(m.guildId);
        if (!guild)
            continue;
        const startMs = m.startAt.getTime();
        const sent = new Set(m.remindersSent.split(",").filter(Boolean));
        // Fire any due reminders that haven't been sent.
        for (const off of REMINDER_OFFSETS) {
            const fireAt = startMs - off.ms;
            if (now >= fireAt && !sent.has(off.key)) {
                // Skip stale pre-start reminders if we're already well past them
                // (e.g. meeting created < offset before start) — only fire within 6h late.
                if (off.key !== "start" && now - fireAt > 6 * 3600_000) {
                    sent.add(off.key);
                    await persistRemindersSent(m.id, sent);
                    continue;
                }
                // Only mark the reminder sent if it actually delivered. A transient
                // failure (e.g. Discord API timeout) leaves it unsent so the next
                // sweep (30s) retries instead of silently dropping the reminder.
                const delivered = await sendNotification(guild, m, off.label);
                if (delivered) {
                    sent.add(off.key);
                    await persistRemindersSent(m.id, sent);
                }
            }
        }
        // Begin monitoring at start. Track the transition locally too — reading the
        // stale snapshot below would skip this pass's tick and end.
        let status = m.status;
        if (status === "scheduled" && now >= startMs) {
            await prisma.meeting.update({ where: { id: m.id }, data: { status: "monitoring" } });
            status = "monitoring";
            await onMeetingStart({ ...m, status }).catch((err) => logger.error({ err, meeting: m.id }, "onMeetingStart failed"));
        }
        // While monitoring, record live attendance each sweep.
        const endMs = startMs + (m.durationMin + m.attendanceWindowMin) * 60_000;
        if (status === "monitoring" && now < endMs) {
            await onMeetingTick(m).catch((err) => logger.error({ err, meeting: m.id }, "onMeetingTick failed"));
        }
        // Finalize once the meeting + attendance window has elapsed.
        if (status === "monitoring" && now >= endMs) {
            await prisma.meeting.update({ where: { id: m.id }, data: { status: "completed" } });
            await onMeetingEnd({ ...m, status: "completed" }).catch((err) => logger.error({ err, meeting: m.id }, "onMeetingEnd failed"));
        }
    }
    // Self-heal any leftovers from failed revokes/deletes on earlier meetings.
    await cleanupMeetingOrphans(meetings).catch((err) => logger.warn({ err }, "Meeting orphan cleanup failed"));
}
export function startScheduler(c) {
    client = c;
    if (sweepTimer)
        clearInterval(sweepTimer);
    sweepTimer = setInterval(() => void sweep().catch((err) => logger.error({ err }, "sweep error")), 30_000);
    logger.info("Meeting scheduler started (30s sweep)");
    void sweep();
}
export function stopScheduler() {
    if (sweepTimer)
        clearInterval(sweepTimer);
    sweepTimer = null;
}
//# sourceMappingURL=meetingScheduler.js.map