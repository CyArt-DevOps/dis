/**
 * CyGRC had its project key renamed (grc -> cygrc). Bootstrap created a fresh
 * set of "cygrc-*" channels but never removed the old "grc-*" ones, leaving
 * duplicate channels in the CYGRC / CyGRC M1 / CyGRC M2 categories.
 *
 * This script finds the orphaned old-key channels (names starting "grc-" or
 * "lead-grc-") that sit inside a CyGRC category, reports each one's non-bot
 * message count, and deletes them ONLY when CONFIRM=1 is set.
 *
 *   npx tsx scripts/clean-cygrc-orphans.ts             # report only
 *   CONFIRM=1 npx tsx scripts/clean-cygrc-orphans.ts   # delete
 */
import { ChannelType, Events, GuildBasedChannel } from "discord.js";
import { env } from "../src/config/env.js";
import { createClient } from "../src/core/client.js";
import { logger } from "../src/core/logger.js";

const CONFIRM = process.env.CONFIRM === "1";
const ORPHAN_RE = /^(grc-|lead-grc-)/;

async function main() {
  const client = createClient();
  client.once(Events.ClientReady, async (c) => {
    const guild = await (await c.guilds.fetch(env.DISCORD_GUILD_ID)).fetch();
    await guild.channels.fetch();

    // Category ids belonging to CyGRC (name CYGRC or "CyGRC M<n>").
    const cygrcCatIds = new Set(
      guild.channels.cache
        .filter(
          (ch) =>
            ch.type === ChannelType.GuildCategory &&
            (ch.name === "CYGRC" || /^CyGRC( M\d+)?$/.test(ch.name))
        )
        .map((ch) => ch.id)
    );

    const orphans: GuildBasedChannel[] = [];
    for (const ch of guild.channels.cache.values()) {
      if (ch.type === ChannelType.GuildCategory) continue;
      if (!ch.parentId || !cygrcCatIds.has(ch.parentId)) continue;
      if (ORPHAN_RE.test(ch.name)) orphans.push(ch);
    }

    if (orphans.length === 0) {
      logger.info("No orphan grc-* channels found. Nothing to do.");
      client.destroy();
      process.exit(0);
    }

    const me = guild.members.me?.id ?? c.user.id;
    for (const ch of orphans) {
      let humanMsgs = "n/a";
      if (ch.type === ChannelType.GuildText && "messages" in ch) {
        const msgs = await ch.messages.fetch({ limit: 100 }).catch(() => null);
        if (msgs) {
          const human = msgs.filter((m) => m.author.id !== me).size;
          humanMsgs = `${human} human / ${msgs.size} total`;
        }
      }
      const parent = ch.parentId ? guild.channels.cache.get(ch.parentId)?.name : "(none)";
      logger.info(
        { channel: ch.name, in: parent, humanMsgs },
        CONFIRM ? "Deleting orphan" : "[report] orphan channel"
      );
      if (CONFIRM) {
        await ch
          .delete("Duplicate old-key (grc-*) channel after rename to cygrc")
          .then(() => logger.info({ channel: ch.name }, "Deleted"))
          .catch((err) =>
            logger.error({ channel: ch.name, err: (err as Error).message }, "Delete failed")
          );
      }
    }

    logger.info(
      { count: orphans.length, deleted: CONFIRM },
      CONFIRM ? "Orphan cleanup complete" : "Report complete — re-run with CONFIRM=1 to delete"
    );
    client.destroy();
    process.exit(0);
  });
  await client.login(env.DISCORD_TOKEN);
}
main().catch((err) => {
  logger.error({ err }, "clean-cygrc-orphans fatal");
  process.exit(1);
});
