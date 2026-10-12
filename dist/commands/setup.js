import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from "discord.js";
import { bootstrapServer } from "../services/bootstrap.js";
import { isFounder } from "../lib/rbac.js";
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
            await interaction.editReply(`Done. New roles: ${report.rolesCreated}. Active projects built: ${report.projectsBuilt}.`);
        }
        catch (err) {
            await interaction.editReply(`Bootstrap failed: ${err instanceof Error ? err.message : "unknown error"}`);
            throw err;
        }
    },
};
//# sourceMappingURL=setup.js.map