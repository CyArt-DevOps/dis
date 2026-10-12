import { Events } from "discord.js";
import { env } from "../src/config/env.js";
import { createClient } from "../src/core/client.js";
import { bootstrapServer } from "../src/services/bootstrap.js";
import { logger } from "../src/core/logger.js";

async function main() {
  const client = createClient();

  client.once(Events.ClientReady, async (c) => {
    logger.info({ user: c.user.tag }, "Connected; building server");
    const guild = await c.guilds.fetch(env.DISCORD_GUILD_ID);
    const full = await guild.fetch();
    try {
      const report = await bootstrapServer(full);
      logger.info(report, "Server build complete");
    } catch (err) {
      logger.error({ err }, "Server build failed");
    } finally {
      client.destroy();
      process.exit(0);
    }
  });

  await client.login(env.DISCORD_TOKEN);
}

main().catch((err) => {
  logger.error({ err }, "build-server fatal");
  process.exit(1);
});
