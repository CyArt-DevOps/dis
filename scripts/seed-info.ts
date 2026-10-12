/**
 * Standalone: post/repost the rules, intern-guide, and announcements content.
 * Uses the seedInfoContent from bootstrap so it is version-tracked in
 * data/state.json and safely idempotent. Intended for one-off runs and for
 * scheduled tasks. Does NOT touch roles, channels, or panels.
 */
import { ChannelType, Client, Events, type CategoryChannel } from "discord.js";
import { env } from "../src/config/env.js";
import { logger } from "../src/core/logger.js";
import { org } from "../src/config/loader.js";
import { seedInfoContent } from "../src/services/bootstrap.js";

async function main() {
  const client = new Client({
    intents: [
      // GuildMessages + MessageContent needed so the seed can find and delete
      // its prior seed messages.
      1 << 0 /* Guilds */,
      1 << 9 /* GuildMessages */,
      1 << 15 /* MessageContent */,
    ],
  });

  client.once(Events.ClientReady, async (c) => {
    logger.info({ user: c.user.tag }, "Connected. Seeding info content.");
    try {
      const guild = await (await c.guilds.fetch(env.DISCORD_GUILD_ID)).fetch();
      const info = guild.channels.cache.find(
        (ch) =>
          ch.type === ChannelType.GuildCategory &&
          ch.name === org.categories.information.name
      ) as CategoryChannel | undefined;
      if (!info) {
        logger.error("INFORMATION category not found. Aborting.");
      } else {
        await seedInfoContent(guild, info);
        logger.info("Info seed complete.");
      }
    } catch (err) {
      logger.error({ err }, "Seed script failed");
    } finally {
      await client.destroy();
      process.exit(0);
    }
  });

  await client.login(env.DISCORD_TOKEN);
}

main().catch((err) => {
  logger.error({ err }, "Fatal");
  process.exit(1);
});
