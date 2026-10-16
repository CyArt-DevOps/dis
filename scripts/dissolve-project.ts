/**
 * Same as `/project dissolve <key>`: deletes the project's categories,
 * channels and roles, drops it from config/org.json, writes a JSON snapshot to
 * data/backups. Run scripts/export-project.ts first — messages are not kept.
 *
 *   npx tsx scripts/dissolve-project.ts <project-key>
 */
import { Events } from "discord.js";
import { env } from "../src/config/env.js";
import { org } from "../src/config/loader.js";
import { createClient } from "../src/core/client.js";
import { logger } from "../src/core/logger.js";
import { dissolveProject } from "../src/services/projectMgmt.js";

async function main() {
  const key = process.argv[2];
  if (!org.projects.some((p) => p.key === key)) {
    console.error(`Usage: tsx scripts/dissolve-project.ts <key>. Unknown key '${key}'.`);
    process.exit(1);
  }
  const client = createClient();
  client.once(Events.ClientReady, async (c) => {
    const guild = await (await c.guilds.fetch(env.DISCORD_GUILD_ID)).fetch();
    await guild.channels.fetch();
    await guild.roles.fetch();
    const backup = await dissolveProject(guild, key!);
    console.log(`Dissolved ${key}. Snapshot: ${backup}`);
    client.destroy();
    process.exit(0);
  });
  await client.login(env.DISCORD_TOKEN);
}

main().catch((err) => {
  logger.error({ err }, "dissolve fatal");
  process.exit(1);
});
