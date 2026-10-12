/**
 * Rename a project from the CLI — same code path as `/project rename`, for when
 * the bot isn't running the patched build or you're fixing config drift.
 *
 *   KEY=grc-20 NAME="GRC 2" npx tsx scripts/rename-project.ts
 *
 * Renames roles, categories and name-bearing voice channels in the guild, then
 * persists config. Delete any duplicate set FIRST (see clean-grc20-duplicate.ts)
 * — renaming onto names that already exist leaves two identically named
 * categories.
 */
import { Events } from "discord.js";
import { env } from "../src/config/env.js";
import { createClient } from "../src/core/client.js";
import { logger } from "../src/core/logger.js";
import { renameProject } from "../src/services/projectMgmt.js";

const KEY = process.env.KEY;
const NAME = process.env.NAME;

async function main() {
  if (!KEY || !NAME) throw new Error('Set KEY and NAME, e.g. KEY=grc-20 NAME="GRC 2"');
  const client = createClient();
  client.once(Events.ClientReady, async (c) => {
    const guild = await (await c.guilds.fetch(env.DISCORD_GUILD_ID)).fetch();
    await guild.channels.fetch();
    await guild.roles.fetch();
    await renameProject(guild, KEY, NAME);
    logger.info({ key: KEY, name: NAME }, "Rename complete");
    client.destroy();
    process.exit(0);
  });
  await client.login(env.DISCORD_TOKEN);
}
main().catch((err) => {
  logger.error({ err }, "rename-project fatal");
  process.exit(1);
});
