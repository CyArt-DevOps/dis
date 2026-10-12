import { REST, Routes } from "discord.js";
import { env } from "../config/env.js";
import { registry } from "../core/registry.js";
import { logger } from "../core/logger.js";

/**
 * Re-push all guild slash commands to Discord. Needed after any org.json
 * mutation (project create/rename/archive/dissolve) because option choice
 * lists (project/batch dropdowns) are baked into the registered command JSON.
 * Command `data` getters rebuild their builders from the current org config
 * on each access, so this always pushes fresh choices.
 */
export async function syncGuildCommands(): Promise<void> {
  if (registry.commands.size === 0) {
    logger.warn("syncGuildCommands called with empty registry — skipped");
    return;
  }
  const body = Array.from(registry.commands.values()).map((c) => c.data.toJSON());
  const rest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID),
    { body }
  );
  logger.info({ count: body.length }, "Guild slash commands re-synced");
}
