import { EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import { isStaff } from "../lib/rbac.js";
import { activeProjects } from "../config/loader.js";
import { moduleLabel } from "../lib/names.js";
import { buildOverview, buildProjectBreakdown, listInactiveInterns, } from "../services/dashboard.js";
import { fmtDuration } from "../services/attendance.js";
const projectChoices = () => activeProjects()
    .slice(0, 25)
    .map((p) => ({ name: p.name, value: p.key }));
export const dashboard = {
    get data() {
        return new SlashCommandBuilder()
            .setName("dashboard")
            .setDescription("Org analytics")
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .setDMPermission(false)
            .addSubcommand((sc) => sc.setName("overview").setDescription("Org-wide summary"))
            .addSubcommand((sc) => sc
            .setName("project")
            .setDescription("Per-module / per-pod breakdown for a project")
            .addStringOption((o) => o
            .setName("project")
            .setDescription("Project")
            .setRequired(true)
            .addChoices(...projectChoices())))
            .addSubcommand((sc) => sc
            .setName("inactive")
            .setDescription("Interns with no voice activity in the last 7 days"));
    },
    async execute(interaction) {
        if (!interaction.inCachedGuild()) {
            await interaction.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral });
            return;
        }
        const actor = await interaction.guild.members.fetch(interaction.user.id);
        if (!isStaff(actor)) {
            await interaction.reply({ content: "Staff only.", flags: MessageFlags.Ephemeral });
            return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        // Ensure role member caches are populated for accurate counts
        await interaction.guild.members.fetch();
        const sub = interaction.options.getSubcommand();
        if (sub === "overview") {
            const o = await buildOverview(interaction.guild);
            const perProject = o.perProject.length > 0
                ? o.perProject.map((x) => `${x.name}: **${x.count}**`).join("\n")
                : "—";
            const embed = new EmbedBuilder()
                .setTitle("Org Dashboard")
                .setColor(0x5865f2)
                .addFields({ name: "Total interns", value: String(o.totalInterns), inline: true }, { name: "Active projects", value: String(o.activeProjects), inline: true }, { name: "Modules / Pods", value: `${o.totalModules} / ${o.totalPods}`, inline: true }, { name: "Team Leads", value: String(o.teamLeads), inline: true }, { name: "Co-Leads", value: String(o.coLeads), inline: true }, { name: "Active today (voice)", value: String(o.activeToday), inline: true }, { name: "In voice now", value: String(o.liveNow), inline: true }, { name: "Interns per project", value: perProject }, {
                name: "Tickets",
                value: `open ${o.tickets.open} · claimed ${o.tickets.claimed} · closed ${o.tickets.closed}`,
                inline: true,
            }, { name: "Voice this week", value: fmtDuration(o.weeklyVoiceSeconds), inline: true }, { name: "Inactive interns (7d)", value: String(o.inactiveCount), inline: true })
                .setTimestamp(new Date());
            await interaction.editReply({ embeds: [embed] });
            return;
        }
        if (sub === "project") {
            const key = interaction.options.getString("project", true);
            const b = buildProjectBreakdown(interaction.guild, key);
            if (!b) {
                await interaction.editReply("Unknown project.");
                return;
            }
            const embed = new EmbedBuilder()
                .setTitle(`${b.project.name} — breakdown`)
                .setColor(0x9b59b6)
                .setDescription(`Project members: **${b.projectCount}**`);
            for (const m of b.modules) {
                const podLine = m.pods.map((p) => `P${p.pod}: ${p.count}`).join(" · ") || "—";
                embed.addFields({ name: `${moduleLabel(b.project, m.module)} (${m.count})`, value: podLine });
            }
            await interaction.editReply({ embeds: [embed] });
            return;
        }
        if (sub === "inactive") {
            const ids = await listInactiveInterns(interaction.guild);
            if (ids.length === 0) {
                await interaction.editReply("No inactive interns. 🎉");
                return;
            }
            const shown = ids.slice(0, 40).map((id) => `<@${id}>`).join(" ");
            const extra = ids.length > 40 ? `\n…and ${ids.length - 40} more.` : "";
            await interaction.editReply(`**${ids.length}** inactive intern(s) (no voice activity in 7 days):\n${shown}${extra}`);
            return;
        }
    },
};
//# sourceMappingURL=dashboard.js.map