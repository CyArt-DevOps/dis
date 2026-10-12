import { ChannelType, MessageFlags } from "discord.js";
import { TICKET_IDS, canReopenTicket, claimTicket, closeTicket, createTicket, detailsModal, findTicketType, reopenTicket, typeSelect, } from "../services/tickets.js";
import { isStaff } from "../lib/rbac.js";
import { prisma } from "../core/db.js";
import { grantVoiceAccess, ticketTypeToOffice } from "../services/meeting.js";
import { findProject } from "../config/loader.js";
import { roleNames } from "../lib/names.js";
function cid(i) {
    if (i.isButton() ||
        i.isStringSelectMenu() ||
        i.isModalSubmit())
        return i.customId;
    return undefined;
}
export const openHandler = {
    id: "ticket:open",
    matches: (i) => i.isButton() && cid(i) === TICKET_IDS.open,
    async handle(i) {
        if (!i.isButton())
            return;
        await i.reply({
            content: "Pick a category:",
            components: [typeSelect()],
            flags: MessageFlags.Ephemeral,
        });
    },
};
export const openProjectHandler = {
    id: "ticket:openproject",
    matches: (i) => i.isButton() && (cid(i)?.startsWith(TICKET_IDS.openproject + ":") ?? false),
    async handle(i) {
        if (!i.isButton())
            return;
        const projectKey = cid(i).split(":")[2] ?? "";
        // Carry the project key through to the modal so the ticket routes to that
        // project's Team Lead.
        await i.showModal(detailsModal("project", projectKey));
    },
};
export const talkManagerHandler = {
    id: "ticket:talk:manager",
    matches: (i) => i.isButton() && cid(i) === TICKET_IDS.talkManager,
    async handle(i) {
        if (!i.isButton())
            return;
        await i.showModal(detailsModal("meeting"));
    },
};
export const talkHrHandler = {
    id: "ticket:talk:hr",
    matches: (i) => i.isButton() && cid(i) === TICKET_IDS.talkHr,
    async handle(i) {
        if (!i.isButton())
            return;
        await i.showModal(detailsModal("hr-help"));
    },
};
export const typeHandler = {
    id: "ticket:type",
    matches: (i) => i.isStringSelectMenu() && cid(i) === TICKET_IDS.type,
    async handle(i) {
        if (!i.isStringSelectMenu())
            return;
        const key = i.values[0];
        const type = key ? findTicketType(key) : undefined;
        if (!type) {
            await i.reply({ content: "Unknown category.", flags: MessageFlags.Ephemeral });
            return;
        }
        await i.showModal(detailsModal(type.key));
    },
};
export const modalHandler = {
    id: "ticket:modal",
    // createTicket creates a channel + DB rows — defer the ephemeral reply first.
    ack: "reply",
    matches: (i) => i.isModalSubmit() && (cid(i)?.startsWith(TICKET_IDS.modal + ":") ?? false),
    async handle(i) {
        if (!i.isModalSubmit() || !i.inCachedGuild())
            return;
        const parts = cid(i).split(":");
        const key = parts[2] ?? "";
        const projectKey = parts[3]; // present for project-support tickets
        const type = findTicketType(key);
        if (!type) {
            await i.editReply({ content: "Unknown category." });
            return;
        }
        const subject = i.fields.getTextInputValue("subject");
        const details = i.fields.getTextInputValue("details");
        const opener = await i.guild.members.fetch(i.user.id);
        // For project tickets, route to THAT project's Team Lead (+ Manager/Founder).
        let staffOverride;
        if (key === "project" && projectKey) {
            const p = findProject(projectKey);
            if (p)
                staffOverride = [roleNames.projectTeamLead(p), "Manager", "Founder"];
        }
        try {
            const { channelId } = await createTicket(i.guild, opener, type, subject, details, staffOverride);
            await i.editReply(`Ticket created: <#${channelId}>`);
        }
        catch (err) {
            await i.editReply(`Failed: ${err instanceof Error ? err.message : "unknown error"}`);
        }
    },
};
export const claimHandler = {
    id: "ticket:claim",
    matches: (i) => i.isButton() && (cid(i)?.startsWith(TICKET_IDS.claim + ":") ?? false),
    async handle(i) {
        if (!i.isButton() || !i.inCachedGuild())
            return;
        const staff = await i.guild.members.fetch(i.user.id);
        if (!isStaff(staff)) {
            await i.reply({ content: "Staff only.", flags: MessageFlags.Ephemeral });
            return;
        }
        const id = Number(cid(i).split(":")[2]);
        // claimTicket edits channel permissions (Discord API) — defer the public
        // reply first so it can't exceed the 3s window.
        await i.deferReply();
        await claimTicket(i.guild, id, staff);
        await i.editReply({ content: `Claimed by <@${staff.id}>.` });
    },
};
export const closeHandler = {
    id: "ticket:close",
    matches: (i) => i.isButton() && (cid(i)?.startsWith(TICKET_IDS.close + ":") ?? false),
    async handle(i) {
        if (!i.isButton() || !i.inCachedGuild())
            return;
        const member = await i.guild.members.fetch(i.user.id);
        const id = Number(cid(i).split(":")[2]);
        await i.reply({ content: "Closing ticket..." });
        try {
            await closeTicket(i.guild, id, member);
        }
        catch (err) {
            await i.followUp({
                content: `Failed: ${err instanceof Error ? err.message : "unknown error"}`,
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
export const reopenHandler = {
    id: "ticket:reopen",
    matches: (i) => i.isButton() && (cid(i)?.startsWith(TICKET_IDS.reopen + ":") ?? false),
    async handle(i) {
        if (!i.isButton() || !i.inCachedGuild())
            return;
        const member = await i.guild.members.fetch(i.user.id);
        const id = Number(cid(i).split(":")[2]);
        const channel = i.channel;
        if (!channel || channel.type !== ChannelType.GuildText) {
            await i.reply({ content: "Invalid channel.", flags: MessageFlags.Ephemeral });
            return;
        }
        if (!canReopenTicket(channel, member)) {
            await i.reply({ content: "Only this ticket's staff can reopen it.", flags: MessageFlags.Ephemeral });
            return;
        }
        await i.reply({ content: "Reopening ticket..." });
        try {
            await reopenTicket(i.guild, id, member);
        }
        catch (err) {
            await i.followUp({
                content: `Failed: ${err instanceof Error ? err.message : "unknown error"}`,
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
export const vcGrantHandler = {
    id: "ticket:vcgrant",
    matches: (i) => i.isButton() && (cid(i)?.startsWith(TICKET_IDS.vcgrant + ":") ?? false),
    async handle(i) {
        if (!i.isButton() || !i.inCachedGuild())
            return;
        const staff = await i.guild.members.fetch(i.user.id);
        if (!isStaff(staff)) {
            await i.reply({ content: "Staff only.", flags: MessageFlags.Ephemeral });
            return;
        }
        const id = Number(cid(i).split(":")[2]);
        const ticket = await prisma.ticket.findUnique({ where: { id } });
        if (!ticket) {
            await i.reply({ content: "Ticket not found.", flags: MessageFlags.Ephemeral });
            return;
        }
        const office = ticketTypeToOffice(ticket.type);
        if (!office) {
            await i.reply({ content: "This ticket type has no office VC.", flags: MessageFlags.Ephemeral });
            return;
        }
        // grantVoiceAccess hits the Discord API — defer the public reply first.
        await i.deferReply();
        try {
            const res = await grantVoiceAccess(i.guild, ticket.openerId, office, 30, staff.id);
            await i.editReply({
                content: `Granted <@${ticket.openerId}> access to **${res.channelName}** until <t:${Math.floor(res.expiresAt.getTime() / 1000)}:t>.`,
            });
        }
        catch (err) {
            await i.editReply({
                content: `Failed: ${err instanceof Error ? err.message : "unknown"}`,
            });
        }
    },
};
export const ticketHandlers = [
    openHandler,
    openProjectHandler,
    talkManagerHandler,
    talkHrHandler,
    typeHandler,
    modalHandler,
    claimHandler,
    closeHandler,
    reopenHandler,
    vcGrantHandler,
];
//# sourceMappingURL=tickets.js.map