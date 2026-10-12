import { ChannelType, PermissionFlagsBits, SlashCommandBuilder, MessageFlags, } from "discord.js";
import { isStaff } from "../lib/rbac.js";
import { panelButton, panelEmbed, closeTicket } from "../services/tickets.js";
import { prisma } from "../core/db.js";
export const ticket = {
    data: new SlashCommandBuilder()
        .setName("ticket")
        .setDescription("Ticket system")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
        .setDMPermission(false)
        .addSubcommand((sc) => sc
        .setName("panel")
        .setDescription("Post the ticket panel in this channel"))
        .addSubcommand((sc) => sc.setName("close").setDescription("Close the ticket in this channel"))
        .addSubcommand((sc) => sc.setName("stats").setDescription("Show ticket statistics")),
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
        const sub = interaction.options.getSubcommand();
        if (sub === "panel") {
            const ch = interaction.channel;
            if (!ch || ch.type !== ChannelType.GuildText) {
                await interaction.reply({ content: "Text channel only.", flags: MessageFlags.Ephemeral });
                return;
            }
            await ch.send({
                embeds: [panelEmbed()],
                components: [panelButton()],
            });
            await interaction.reply({ content: "Panel posted.", flags: MessageFlags.Ephemeral });
            return;
        }
        if (sub === "close") {
            const ch = interaction.channel;
            const row = ch
                ? await prisma.ticket.findFirst({
                    where: { channelId: ch.id, status: { not: "closed" } },
                })
                : null;
            if (!row) {
                await interaction.reply({
                    content: "No open ticket bound to this channel.",
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }
            await interaction.reply({ content: "Closing...", flags: MessageFlags.Ephemeral });
            await closeTicket(interaction.guild, row.id, actor);
            return;
        }
        if (sub === "stats") {
            const [open, claimed, closed] = await Promise.all([
                prisma.ticket.count({ where: { guildId: interaction.guildId, status: "open" } }),
                prisma.ticket.count({ where: { guildId: interaction.guildId, status: "claimed" } }),
                prisma.ticket.count({ where: { guildId: interaction.guildId, status: "closed" } }),
            ]);
            await interaction.reply({
                content: `Tickets — open: ${open}, claimed: ${claimed}, closed: ${closed}`,
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
    },
};
//# sourceMappingURL=ticket.js.map