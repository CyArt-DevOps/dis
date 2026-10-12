import { Events, PermissionFlagsBits, type Client } from "discord.js";
import { logger } from "../core/logger.js";
import { env } from "../config/env.js";
import { roleNames } from "../lib/names.js";

const REQUIRED_PERMS = [
  { flag: PermissionFlagsBits.ManageRoles, name: "Manage Roles" },
  { flag: PermissionFlagsBits.ManageChannels, name: "Manage Channels" },
  { flag: PermissionFlagsBits.ManageGuild, name: "Manage Server" },
  { flag: PermissionFlagsBits.ModerateMembers, name: "Timeout Members" },
  { flag: PermissionFlagsBits.MoveMembers, name: "Move Members" },
];

async function healthCheck(client: Client): Promise<void> {
  const guild = client.guilds.cache.get(env.DISCORD_GUILD_ID);
  if (!guild) {
    logger.warn({ guild: env.DISCORD_GUILD_ID }, "Configured guild not found in cache");
    return;
  }
  const me = guild.members.me;
  if (!me) return;

  const missing = REQUIRED_PERMS.filter((p) => !me.permissions.has(p.flag)).map(
    (p) => p.name
  );
  if (missing.length > 0) {
    logger.warn({ missing }, "Bot is missing required permissions — some features will fail");
  }

  // Verify the bot's role outranks the roles it must assign.
  const internRole = guild.roles.cache.find((r) => r.name === roleNames.intern());
  if (internRole && me.roles.highest.position <= internRole.position) {
    logger.warn(
      { botPosition: me.roles.highest.position, internPosition: internRole.position },
      "Bot role is below the Intern role — role assignment will FAIL. Drag the bot role to the top of Server Settings → Roles."
    );
  }
}

export function registerReady(client: Client): void {
  client.once(Events.ClientReady, (c) => {
    logger.info({ user: c.user.tag, guilds: c.guilds.cache.size }, "Bot ready");
    void healthCheck(c);
  });
}
