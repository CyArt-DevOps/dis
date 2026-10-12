import { EmbedBuilder, SlashCommandBuilder, MessageFlags } from "discord.js";
import { isStaff } from "../lib/rbac.js";
import { parseDateTime, formatInTz } from "../lib/time.js";
import { prisma } from "../core/db.js";
import { finalizeDecision } from "../interactions/leave.js";
import { createLeaveRequest, listLeaves, pendingLeaves, validateLeave, LEAVE_TYPE_CHOICES, LEAVE_TYPES, } from "../services/leave.js";
// Direct staff grant covers a whole date range, so exam leave (which needs the
// timetable + per-day picker) is handled only through the request/approve flow.
const DIRECT_APPROVE_TYPES = LEAVE_TYPE_CHOICES.filter((c) => c.value !== "exam");
export const leave = {
    data: new SlashCommandBuilder()
        .setName("leave")
        .setDescription("Request and view leave")
        .setDMPermission(false)
        .addSubcommand((sc) => sc
        .setName("request")
        .setDescription("Submit a leave request for HR approval")
        .addStringOption((o) => o.setName("type").setDescription("Leave type").setRequired(true).addChoices(...LEAVE_TYPE_CHOICES))
        .addStringOption((o) => o.setName("start_date").setDescription("DD/MM/YYYY").setRequired(true))
        .addStringOption((o) => o.setName("end_date").setDescription("DD/MM/YYYY").setRequired(true))
        .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true)))
        .addSubcommand((sc) => sc.setName("list").setDescription("Your leave requests"))
        .addSubcommand((sc) => sc.setName("pending").setDescription("Pending leave requests (staff)"))
        .addSubcommand((sc) => sc
        .setName("approve")
        .setDescription("Directly put a member on approved leave (Manager/HR)")
        .addUserOption((o) => o.setName("member").setDescription("Member to put on leave").setRequired(true))
        .addStringOption((o) => o.setName("from").setDescription("Start date DD/MM/YYYY").setRequired(true))
        .addStringOption((o) => o.setName("to").setDescription("End date DD/MM/YYYY").setRequired(true))
        .addStringOption((o) => o.setName("type").setDescription("Leave type (default Casual)").addChoices(...DIRECT_APPROVE_TYPES))
        .addStringOption((o) => o.setName("reason").setDescription("Reason (optional)"))),
    async execute(interaction) {
        if (!interaction.inCachedGuild()) {
            await interaction.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral });
            return;
        }
        const sub = interaction.options.getSubcommand();
        if (sub === "request") {
            const type = interaction.options.getString("type", true);
            const startAt = parseDateTime(interaction.options.getString("start_date", true), "12:00 AM");
            const endAt = parseDateTime(interaction.options.getString("end_date", true), "11:59 PM");
            const reason = interaction.options.getString("reason", true);
            if (!startAt || !endAt) {
                await interaction.reply({
                    content: "Invalid date. Use `DD/MM/YYYY`.",
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }
            if (endAt.getTime() < startAt.getTime()) {
                await interaction.reply({ content: "End must be on/after start.", flags: MessageFlags.Ephemeral });
                return;
            }
            const check = validateLeave(type, startAt, endAt);
            if (!check.ok) {
                await interaction.reply({ content: `❌ ${check.reason}`, flags: MessageFlags.Ephemeral });
                return;
            }
            const member = await interaction.guild.members.fetch(interaction.user.id);
            const { id, channelId } = await createLeaveRequest(member, type, startAt, endAt, reason);
            const where = channelId ? `A private channel with HR has been created: <#${channelId}>.` : "HR will review it.";
            await interaction.reply({
                content: `${LEAVE_TYPES[type].label} request **#${id}** submitted for ${formatInTz(startAt)} → ${formatInTz(endAt)}. ${where}`,
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
        if (sub === "list") {
            const rows = await listLeaves(interaction.guildId, interaction.user.id);
            if (rows.length === 0) {
                await interaction.reply({ content: "No leave requests.", flags: MessageFlags.Ephemeral });
                return;
            }
            const embed = new EmbedBuilder().setTitle("Your leave requests").setColor(0x5865f2);
            for (const r of rows) {
                const label = LEAVE_TYPES[r.type]?.label ?? r.type;
                embed.addFields({
                    name: `#${r.id} · ${label} · ${r.status}`,
                    value: `${formatInTz(r.startAt)} → ${formatInTz(r.endAt)}\n${r.reason}`,
                });
            }
            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
            return;
        }
        if (sub === "pending") {
            const actor = await interaction.guild.members.fetch(interaction.user.id);
            if (!isStaff(actor)) {
                await interaction.reply({ content: "Staff only.", flags: MessageFlags.Ephemeral });
                return;
            }
            const rows = await pendingLeaves(interaction.guildId);
            if (rows.length === 0) {
                await interaction.reply({ content: "No pending leave requests.", flags: MessageFlags.Ephemeral });
                return;
            }
            const embed = new EmbedBuilder().setTitle("Pending leave").setColor(0xfaa61a);
            for (const r of rows) {
                const label = LEAVE_TYPES[r.type]?.label ?? r.type;
                embed.addFields({
                    name: `#${r.id} · ${label} · <@${r.userId}>`,
                    value: `${formatInTz(r.startAt)} → ${formatInTz(r.endAt)}\n${r.reason}${r.documentUrl ? `\n[document](${r.documentUrl})` : ""}`,
                });
            }
            await interaction.reply({
                embeds: [embed],
                content: "Approve/Reject from the **#leave-approvals** channel.",
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
        if (sub === "approve") {
            const actor = await interaction.guild.members.fetch(interaction.user.id);
            // Same guard as the approve button ("Only HR/Manager/Founder can decide leave").
            if (!isStaff(actor)) {
                await interaction.reply({ content: "Only HR/Manager/Founder can decide leave.", flags: MessageFlags.Ephemeral });
                return;
            }
            const target = interaction.options.getUser("member", true);
            if (target.bot) {
                await interaction.reply({ content: "Can't put a bot on leave.", flags: MessageFlags.Ephemeral });
                return;
            }
            const startAt = parseDateTime(interaction.options.getString("from", true), "12:00 AM");
            const endAt = parseDateTime(interaction.options.getString("to", true), "11:59 PM");
            if (!startAt || !endAt) {
                await interaction.reply({ content: "Invalid date. Use `DD/MM/YYYY`.", flags: MessageFlags.Ephemeral });
                return;
            }
            if (endAt.getTime() < startAt.getTime()) {
                await interaction.reply({ content: "End must be on/after start.", flags: MessageFlags.Ephemeral });
                return;
            }
            const type = interaction.options.getString("type") ?? "casual";
            const reason = interaction.options.getString("reason") ?? `Directly approved by ${actor.displayName}`;
            // Insert an already-tracked leave row (no request channel / HR ping — this
            // is a staff-initiated grant, not a member request), then run the exact
            // same downstream logic as the Approve button via finalizeDecision:
            // audit log, member DM, and Team Lead handover notification. The private-
            // channel close step is skipped automatically because channelId is null.
            const row = await prisma.leaveRequest.create({
                data: {
                    guildId: interaction.guildId,
                    userId: target.id,
                    type,
                    startAt,
                    endAt,
                    reason,
                    status: "pending",
                },
            });
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await finalizeDecision(interaction, actor, row.id, true);
            return;
        }
    },
};
//# sourceMappingURL=leave.js.map