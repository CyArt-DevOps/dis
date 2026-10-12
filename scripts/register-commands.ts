import { REST, Routes } from "discord.js";
import { env } from "../src/config/env.js";
import { registry } from "../src/core/registry.js";
import { registerAllCommands } from "../src/commands/index.js";
import { logger } from "../src/core/logger.js";

async function main() {
  registerAllCommands();
  const body = Array.from(registry.commands.values()).map((c) => c.data.toJSON());

  const rest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);
  logger.info({ count: body.length, guild: env.DISCORD_GUILD_ID }, "Registering guild commands");

  const data = (await rest.put(
    Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID),
    { body }
  )) as unknown[];

  logger.info({ registered: data.length }, "Commands registered");
}

main().catch((err) => {
  logger.error({ err }, "Command registration failed");
  process.exit(1);
});
