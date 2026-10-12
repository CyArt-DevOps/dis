/**
 * The grc-20 project's display name was changed from "GRC 2" to "CyGRC 2.0"
 * without renaming the guild assets. Bootstrap (run by the SilentMesh project
 * create) matched nothing under the new name and built a second, empty copy of
 * the whole project, orphaning the real "GRC 2" categories that members use.
 *
 * This deletes ONLY the empty "CyGRC 2.0" duplicate:
 *   categories  CYGRC 2.0, CyGRC 2.0 M1, CyGRC 2.0 M2  (+ their channels)
 *   roles       CyGRC 2.0*  — skipped unless the role has 0 members
 *
 * "GRC 2" assets are never touched, and any channel holding a non-bot message
 * is skipped (so is its category) — the duplicate should be empty; if it isn't,
 * you're looking at the wrong set.
 *
 *   npx tsx scripts/clean-grc20-duplicate.ts             # report only
 *   CONFIRM=1 npx tsx scripts/clean-grc20-duplicate.ts   # delete
 */
import { ChannelType, Events, GuildBasedChannel } from "discord.js";
import { env } from "../src/config/env.js";
import { createClient } from "../src/core/client.js";
import { logger } from "../src/core/logger.js";

const CONFIRM = process.env.CONFIRM === "1";
const DUP_NAME = "CyGRC 2.0";
const DUP_CATEGORIES = new Set([
  DUP_NAME.toUpperCase(),
  `${DUP_NAME} M1`,
  `${DUP_NAME} M2`,
]);
const KEEP_PREFIX = "GRC 2";

async function humanMessageCount(ch: GuildBasedChannel, botId: string): Promise<number> {
  if (ch.type !== ChannelType.GuildText || !("messages" in ch)) return 0;
  const msgs = await ch.messages.fetch({ limit: 100 }).catch(() => null);
  if (!msgs) return 0;
  return msgs.filter((m) => m.author.id !== botId).size;
}

async function main() {
  const client = createClient();
  client.once(Events.ClientReady, async (c) => {
    const guild = await (await c.guilds.fetch(env.DISCORD_GUILD_ID)).fetch();
    await guild.channels.fetch();
    await guild.members.fetch();

    const cats = guild.channels.cache.filter(
      (ch) => ch.type === ChannelType.GuildCategory && DUP_CATEGORIES.has(ch.name)
    );
    if (cats.size === 0) {
      logger.info("No 'CyGRC 2.0' categories found. Nothing to do.");
      client.destroy();
      process.exit(0);
    }

    const botId = guild.members.me?.id ?? c.user.id;
    let blocked = 0;

    for (const cat of cats.values()) {
      // Paranoia: never let a "GRC 2" asset through on a name near-miss.
      if (cat.name.startsWith(KEEP_PREFIX)) continue;

      const children = guild.channels.cache.filter((ch) => ch.parentId === cat.id);
      const counts = new Map<string, number>();
      for (const ch of children.values()) counts.set(ch.id, await humanMessageCount(ch, botId));

      const withHistory = [...children.values()].filter((ch) => (counts.get(ch.id) ?? 0) > 0);
      if (withHistory.length > 0) {
        blocked++;
        logger.warn(
          { category: cat.name, channels: withHistory.map((ch) => ch.name) },
          "Category has human messages — skipping entirely, inspect manually"
        );
        continue;
      }

      for (const ch of children.values()) {
        logger.info(
          { channel: ch.name, in: cat.name },
          CONFIRM ? "Deleting duplicate channel" : "[report] duplicate channel"
        );
        if (CONFIRM) {
          await ch
            .delete("Empty duplicate created by CyGRC 2.0 rename drift")
            .catch((err) =>
              logger.error({ channel: ch.name, err: (err as Error).message }, "Delete failed")
            );
        }
      }
      logger.info(
        { category: cat.name },
        CONFIRM ? "Deleting duplicate category" : "[report] duplicate category"
      );
      if (CONFIRM) {
        await cat
          .delete("Empty duplicate created by CyGRC 2.0 rename drift")
          .catch((err) =>
            logger.error({ category: cat.name, err: (err as Error).message }, "Delete failed")
          );
      }
    }

    for (const role of guild.roles.cache.values()) {
      if (role.name !== DUP_NAME && !role.name.startsWith(`${DUP_NAME} `)) continue;
      if (role.members.size > 0) {
        logger.warn(
          { role: role.name, members: role.members.size },
          "Role has members — skipping, this may be a live role"
        );
        blocked++;
        continue;
      }
      logger.info({ role: role.name }, CONFIRM ? "Deleting duplicate role" : "[report] duplicate role");
      if (CONFIRM) {
        await role
          .delete("Empty duplicate created by CyGRC 2.0 rename drift")
          .catch((err) =>
            logger.error({ role: role.name, err: (err as Error).message }, "Delete failed")
          );
      }
    }

    logger.info(
      { deleted: CONFIRM, blocked },
      CONFIRM
        ? "Cleanup complete — now run /project rename project:CyGRC 2.0 new_name:GRC 2"
        : "Report complete — re-run with CONFIRM=1 to delete"
    );
    client.destroy();
    process.exit(0);
  });
  await client.login(env.DISCORD_TOKEN);
}
main().catch((err) => {
  logger.error({ err }, "clean-grc20-duplicate fatal");
  process.exit(1);
});
