import { SlashCommandBuilder, MessageFlags } from "discord.js";
export const ping = {
    data: new SlashCommandBuilder()
        .setName("ping")
        .setDescription("Health check"),
    async execute(interaction) {
        await interaction.reply({
            content: `Pong. WS ${interaction.client.ws.ping}ms`,
            flags: MessageFlags.Ephemeral,
        });
    },
};
//# sourceMappingURL=ping.js.map