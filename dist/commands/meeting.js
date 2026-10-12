import { ActionRowBuilder, ChannelType, EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder, UserSelectMenuBuilder, MessageFlags, } from "discord.js";
import { isStaff } from "../lib/rbac.js";
import { grantVoiceAccess, revokeNow, getOfficeVoiceChannel } from "../services/meeting.js";
import { MEETING_PEOPLE_SELECT_ID } from "../interactions/meetingPeople.js";
import { setPendingPeopleMeeting } from "../services/pendingPeopleMeetings.js";
import { audienceLabel, cancelMeeting, renotifyMeeting, resolveAudienceRole, scheduleMeeting, } from "../services/meetingScheduler.js";
import { activeProjects, findProject, org } from "../config/loader.js";
import { roleNames } from "../lib/names.js";
import { parseDateTime, formatInTz, tzName, discordTimestamp } from "../lib/time.js";
import { prisma } from "../core/db.js";
const OFFICES = [
    { name: "Manager Office", value: "manager" },
    { name: "HR Office", value: "hr" },
];
const AUDIENCES = [
    { name: "Entire Organization", value: "org" },
    { name: "Batch", value: "batch" },
    { name: "Project", value: "project" },
    { name: "Module", value: "module" },
    { name: "Pod", value: "pod" },
    { name: "Specific People", value: "people" },
];
const projectChoices = () => activeProjects().slice(0, 25).map((p) => ({ name: p.name, value: p.key }));
const batchChoices = () => org.batches.slice(0, 25).map((b) => ({ name: b, value: b }));
/**
 * Who may schedule a meeting for the given audience.
 *
 * Founder/Manager/HR: anything.
 * Project Team Leads: their OWN project, and any module or pod inside it —
 *   scoped by the per-project "<Project> Team Lead" role (assignLead grants it
 *   alongside the base role), so a lead of one project cannot schedule for
 *   another, and cannot schedule org- or batch-wide.
 * Co-Leads: no scheduling at all.
 */
export function canSchedule(actor, audienceType, projectKey) {
    if (isStaff(actor))
        return true;
    // "Specific People" meetings hand out office VC access — staff only.
    if (audienceType === "people")
        return false;
    // Org- and batch-wide meetings cross project boundaries — staff only.
    if (audienceType === "org" || audienceType === "batch")
        return false;
    const p = projectKey ? findProject(projectKey) : undefined;
    if (!p)
        return false;
    return actor.roles.cache.some((r) => r.name === roleNames.projectTeamLead(p));
}
export const meeting = {
    // Getter: rebuilds choices from current org config each time, so command
    // re-sync after /project mutations pushes fresh project/batch lists.
    get data() {
        return new SlashCommandBuilder()
            .setName("meeting")
            .setDescription("Schedule meetings and manage office voice access")
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
            .setDMPermission(false)
            .addSubcommand((sc) => sc
            .setName("schedule")
            .setDescription("Schedule a meeting with reminders + attendance")
            .addStringOption((o) => o.setName("title").setDescription("Meeting title").setRequired(true))
            .addStringOption((o) => o.setName("date").setDescription("Date DD/MM/YYYY").setRequired(true))
            .addStringOption((o) => o.setName("start").setDescription("Start time, e.g. 2:30 PM").setRequired(true))
            .addIntegerOption((o) => o.setName("duration").setDescription("Duration in minutes").setRequired(true).setMinValue(5).setMaxValue(600))
            .addStringOption((o) => o.setName("audience").setDescription("Who must attend").setRequired(true).addChoices(...AUDIENCES))
            .addChannelOption((o) => o
            .setName("voice_channel")
            .setDescription("Meeting voice channel (not used for Specific People — pick office instead)")
            .addChannelTypes(ChannelType.GuildVoice))
            .addStringOption((o) => o.setName("description").setDescription("Details"))
            .addStringOption((o) => o.setName("project").setDescription("Project (for project/module/pod)").addChoices(...projectChoices()))
            .addIntegerOption((o) => o.setName("module").setDescription("Module number").setMinValue(1))
            .addIntegerOption((o) => o.setName("pod").setDescription("Pod number").setMinValue(1))
            .addStringOption((o) => o.setName("batch").setDescription("Batch (for batch audience)").addChoices(...batchChoices()))
            .addBooleanOption((o) => o.setName("mandatory").setDescription("Mandatory? (default yes)"))
            .addIntegerOption((o) => o.setName("window").setDescription("Attendance window minutes (default 10)").setMinValue(1).setMaxValue(120))
            .addStringOption((o) => o
            .setName("office")
            .setDescription("Specific People only: which office VC to grant access to")
            .addChoices(...OFFICES)))
            .addSubcommand((sc) => sc.setName("list").setDescription("List upcoming meetings"))
            .addSubcommand((sc) => sc
            .setName("cancel")
            .setDescription("Cancel a scheduled meeting")
            .addIntegerOption((o) => o.setName("id").setDescription("Meeting ID").setRequired(true)))
            .addSubcommand((sc) => sc
            .setName("notify")
            .setDescription("Re-send a meeting's notification to its audience channel")
            .addIntegerOption((o) => o.setName("id").setDescription("Meeting ID").setRequired(true)))
            .addSubcommand((sc) => sc
            .setName("grant")
            .setDescription("Grant a member temporary access to an office VC")
            .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true))
            .addStringOption((o) => o.setName("office").setDescription("Which office").setRequired(true).addChoices(...OFFICES))
            .addIntegerOption((o) => o.setName("minutes").setDescription("Duration (default 30)").setMinValue(1).setMaxValue(480)))
            .addSubcommand((sc) => sc
            .setName("revoke")
            .setDescription("Revoke a member's office VC access now")
            .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true))
            .addStringOption((o) => o.setName("office").setDescription("Which office").setRequired(true).addChoices(...OFFICES)));
    },
    async execute(interaction) {
        if (!interaction.inCachedGuild()) {
            await interaction.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral });
            return;
        }
        const actor = await interaction.guild.members.fetch(interaction.user.id);
        const sub = interaction.options.getSubcommand();
        if (sub === "schedule") {
            await handleSchedule(interaction, actor);
            return;
        }
        if (sub === "list") {
            await handleList(interaction);
            return;
        }
        if (sub === "cancel") {
            await handleCancel(interaction, actor);
            return;
        }
        if (sub === "notify") {
            await handleNotify(interaction, actor);
            return;
        }
        // grant / revoke — staff only
        if (!isStaff(actor)) {
            await interaction.reply({ content: "Staff only.", flags: MessageFlags.Ephemeral });
            return;
        }
        const user = interaction.options.getUser("member", true);
        const office = interaction.options.getString("office", true);
        if (sub === "grant") {
            const minutes = interaction.options.getInteger("minutes") ?? 30;
            try {
                const res = await grantVoiceAccess(interaction.guild, user.id, office, minutes, actor.id);
                await interaction.reply({
                    content: `Granted <@${user.id}> access to **${res.channelName}** until <t:${Math.floor(res.expiresAt.getTime() / 1000)}:t>.`,
                    flags: MessageFlags.Ephemeral,
                });
            }
            catch (err) {
                await interaction.reply({
                    content: `Failed: ${err instanceof Error ? err.message : "unknown"}`,
                    flags: MessageFlags.Ephemeral,
                });
            }
            return;
        }
        if (sub === "revoke") {
            await revokeNow(interaction.guild, user.id, office);
            await interaction.reply({
                content: `Revoked <@${user.id}>'s access to the ${office} office.`,
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
async function handleSchedule(interaction, actor) {
    const audienceType = interaction.options.getString("audience", true);
    const projectKey = interaction.options.getString("project") ?? undefined;
    const moduleNum = interaction.options.getInteger("module") ?? undefined;
    const podNum = interaction.options.getInteger("pod") ?? undefined;
    const batch = interaction.options.getString("batch") ?? undefined;
    const office = interaction.options.getString("office") ?? undefined;
    const voiceChannelOpt = interaction.options.getChannel("voice_channel");
    // Validate audience parameters BEFORE the permission check: scheduling rights
    // are scoped by project, so a missing `project` would otherwise be reported as
    // "you can't schedule this" when the real problem is an unfilled option.
    if ((audienceType === "project" || audienceType === "module" || audienceType === "pod") && !projectKey) {
        await interaction.reply({ content: "`project` is required for this audience.", flags: MessageFlags.Ephemeral });
        return;
    }
    if ((audienceType === "module" || audienceType === "pod") && !moduleNum) {
        await interaction.reply({ content: "`module` is required for this audience.", flags: MessageFlags.Ephemeral });
        return;
    }
    if (audienceType === "pod" && !podNum) {
        await interaction.reply({ content: "`pod` is required for a pod meeting.", flags: MessageFlags.Ephemeral });
        return;
    }
    if (audienceType === "batch" && !batch) {
        await interaction.reply({ content: "`batch` is required for a batch meeting.", flags: MessageFlags.Ephemeral });
        return;
    }
    if (!canSchedule(actor, audienceType, projectKey)) {
        const p = projectKey ? findProject(projectKey) : undefined;
        await interaction.reply({
            content: "You can't schedule this meeting.\n" +
                "• **Founder / Manager / HR** — any meeting.\n" +
                "• **Team Lead** — project, module and pod meetings for your own project only.\n" +
                "• **Co-Lead** — cannot schedule meetings.\n" +
                "Org-wide, batch and Specific People meetings are Founder/Manager/HR only." +
                (p ? `\n\nFor this one you need the **${roleNames.projectTeamLead(p)}** role.` : ""),
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    let voiceChannelId;
    if (audienceType === "people") {
        if (!office) {
            await interaction.reply({ content: "`office` is required for a Specific People meeting.", flags: MessageFlags.Ephemeral });
            return;
        }
        const vc = getOfficeVoiceChannel(interaction.guild, office);
        if (!vc) {
            await interaction.reply({
                content: `${office === "manager" ? "Manager" : "HR"} Office voice channel not found. Run /setup.`,
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
        voiceChannelId = vc.id;
    }
    else {
        if (!voiceChannelOpt) {
            await interaction.reply({ content: "`voice_channel` is required for this audience.", flags: MessageFlags.Ephemeral });
            return;
        }
        voiceChannelId = voiceChannelOpt.id;
    }
    const startAt = parseDateTime(interaction.options.getString("date", true), interaction.options.getString("start", true));
    if (!startAt) {
        await interaction.reply({
            content: "Invalid date/time. Use date `DD/MM/YYYY` and start like `2:30 PM`.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    if (startAt.getTime() <= Date.now()) {
        await interaction.reply({ content: "Start time must be in the future.", flags: MessageFlags.Ephemeral });
        return;
    }
    const baseArgs = {
        guild: interaction.guild,
        organizerId: actor.id,
        title: interaction.options.getString("title", true),
        description: interaction.options.getString("description") ?? undefined,
        startAt,
        durationMin: interaction.options.getInteger("duration", true),
        audienceType,
        audienceBatch: batch,
        audienceProject: projectKey,
        audienceModule: moduleNum,
        audiencePod: podNum,
        office,
        voiceChannelId,
        mandatory: interaction.options.getBoolean("mandatory") ?? true,
        attendanceWindowMin: interaction.options.getInteger("window") ?? 10,
    };
    if (audienceType === "people") {
        setPendingPeopleMeeting(actor.id, baseArgs);
        const select = new UserSelectMenuBuilder()
            .setCustomId(MEETING_PEOPLE_SELECT_ID)
            .setPlaceholder("Select people for this meeting")
            .setMinValues(1)
            .setMaxValues(25);
        const row = new ActionRowBuilder().addComponents(select);
        await interaction.reply({
            content: `**${baseArgs.title}**\n` +
                `When: ${formatInTz(startAt)} (${tzName()}) · ${discordTimestamp(startAt, "R")}\n` +
                `Office: ${office === "manager" ? "Manager Office" : "HR Office"}\n\n` +
                "Pick the people for this meeting below (up to 25). This expires in 10 minutes.",
            components: [row],
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    // Everything past this point can outrun Discord's 3s ack window: a full
    // member chunk on a 1000-member guild alone takes seconds. Without the defer
    // the interaction expired, the user saw "The application did not respond",
    // and the meeting was still created — so retries piled up duplicates.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.guild.members.fetch().catch(() => { });
    const role = resolveAudienceRole(interaction.guild, baseArgs);
    if (!role) {
        await interaction.editReply({
            content: "Could not resolve the audience role — check the project/module/pod exists (run /setup).",
        });
        return;
    }
    const m = await scheduleMeeting(baseArgs);
    await interaction.editReply({
        content: `Scheduled **#${m.id} — ${m.title}**\n` +
            `When: ${formatInTz(startAt)} (${tzName()}) · ${discordTimestamp(startAt, "R")}\n` +
            `Audience: ${audienceLabel(baseArgs)} (${role.members.size} members)\n` +
            `Reminders: 24h / 1h / 15m / 5m / start. Attendance window: ${baseArgs.attendanceWindowMin}m.`,
    });
}
async function handleList(interaction) {
    const meetings = await prisma.meeting.findMany({
        where: { guildId: interaction.guildId, status: { in: ["scheduled", "monitoring"] } },
        orderBy: { startAt: "asc" },
        take: 15,
    });
    if (meetings.length === 0) {
        await interaction.reply({ content: "No upcoming meetings.", flags: MessageFlags.Ephemeral });
        return;
    }
    const embed = new EmbedBuilder().setTitle("Upcoming meetings").setColor(0x5865f2);
    for (const m of meetings) {
        embed.addFields({
            name: `#${m.id} · ${m.title}`,
            value: `${formatInTz(m.startAt)} · ${m.durationMin}m · <#${m.voiceChannelId}> · ${m.status}`,
        });
    }
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
async function handleCancel(interaction, actor) {
    const id = interaction.options.getInteger("id", true);
    const m = await prisma.meeting.findUnique({ where: { id } });
    if (!m || m.guildId !== interaction.guildId) {
        await interaction.reply({ content: "Meeting not found.", flags: MessageFlags.Ephemeral });
        return;
    }
    if (!isStaff(actor) && m.organizerId !== actor.id) {
        await interaction.reply({ content: "Only staff or the organizer can cancel.", flags: MessageFlags.Ephemeral });
        return;
    }
    await cancelMeeting(id);
    await interaction.reply({ content: `Cancelled meeting #${id}.`, flags: MessageFlags.Ephemeral });
}
async function handleNotify(interaction, actor) {
    const id = interaction.options.getInteger("id", true);
    const m = await prisma.meeting.findUnique({ where: { id } });
    if (!m || m.guildId !== interaction.guildId) {
        await interaction.reply({ content: "Meeting not found.", flags: MessageFlags.Ephemeral });
        return;
    }
    if (!isStaff(actor) && m.organizerId !== actor.id) {
        await interaction.reply({ content: "Only staff or the organizer can re-notify.", flags: MessageFlags.Ephemeral });
        return;
    }
    if (m.status === "cancelled" || m.status === "completed") {
        await interaction.reply({ content: `Meeting #${id} is ${m.status} — nothing to notify.`, flags: MessageFlags.Ephemeral });
        return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
        const where = await renotifyMeeting(interaction.guild, m);
        await interaction.editReply(`Notification for **#${m.id} — ${m.title}** sent to ${where}.`);
    }
    catch (err) {
        await interaction.editReply(`Could not send notification: ${err instanceof Error ? err.message : "unknown error"}`);
    }
}
//# sourceMappingURL=meeting.js.map