import { Events, type Client } from "discord.js";
import { logger } from "../core/logger.js";

export function registerGuildMemberAdd(client: Client): void {
  client.on(Events.GuildMemberAdd, (member) => {
    // No welcome DM. Unsolicited DMs to every joiner (hundreds of interns
    // arriving in waves) are what Discord's anti-spam system flags, and it
    // quarantined the bot's DMs. The persistent verification panel in
    // #welcome already tells new members what to do.
    logger.debug({ user: member.id }, "Member joined");
  });
}
