import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from "discord.js";
import { bootstrapServer } from "../services/bootstrap.js";
import { isFounder } from "../lib/rbac.js";
/** The /setup reply, including any Pod Representative roles that could not be made. */
export function setupSummary(report) {
    let out = `Done. New roles: ${report.rolesCreated}. Active projects built: ${report.projectsBuilt}.`;
    const rep = report.repRoles;
    if (rep.renamed > 0)
        out += `\nRenamed ${rep.renamed} legacy Pod Representative role(s) to the numeric form.`;
    if (rep.notCreated > 0) {
        out +=
            `\nWarning: ${rep.notCreated} of ${rep.wanted} Pod Representative role(s) were not created` +
                (rep.error ? ` (${rep.error})` : "") +
                (rep.shortfall > 0 ? `. Free up ${rep.shortfall} role(s) and run /setup again.` : ". Run /setup again later.");
    }
    return out;
}
export const setup = {
    data: new SlashCommandBuilder()
        .setName("setup")
        .setDescription("Bootstrap the org structure (roles, categories, channels). Idempotent.")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false),
    async execute(interaction) {
        if (!interaction.guild || !interaction.member) {
            await interaction.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral });
            return;
        }
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!isFounder(member) && !member.permissions.has(PermissionFlagsBits.Administrator)) {
            await interaction.reply({
                content: "Only the server owner / Founder / Administrator can run /setup.",
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
        await interaction.reply({
            content: "Bootstrapping server. This can take a minute on first run...",
            flags: MessageFlags.Ephemeral,
        });
        try {
            const report = await bootstrapServer(interaction.guild);
            await interaction.editReply(setupSummary(report));
        }
        catch (err) {
            await interaction.editReply(`Bootstrap failed: ${err instanceof Error ? err.message : "unknown error"}`);
            throw err;
        }
    },
};
//# sourceMappingURL=setup.js.map