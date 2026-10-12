import { Events } from "discord.js";
import { logger } from "../core/logger.js";
export function registerGuildMemberAdd(client) {
    client.on(Events.GuildMemberAdd, async (member) => {
        // We do NOT post in #welcome on join — a persistent verification panel is
        // already seeded there during setup, so per-join messages would just flood
        // the channel when many interns join at once. Instead we DM the member a
        // pointer (best-effort; silently skipped if their DMs are closed).
        try {
            await member.send(`Welcome to **${member.guild.name}**.\n\n` +
                `Please open the **#welcome** channel and click **Begin Verification** to select your ` +
                `Batch, Project, Module, and Pod. Your roles and channel access will be assigned automatically.`);
        }
        catch {
            logger.debug({ user: member.id }, "Welcome DM not delivered (DMs closed)");
        }
    });
}
//# sourceMappingURL=guildMemberAdd.js.map