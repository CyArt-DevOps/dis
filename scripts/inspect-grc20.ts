/**
 * Read-only: compare what the DB says about grc-20 members against the roles
 * they actually hold in the guild. Deletes nothing, assigns nothing.
 *
 *   npx tsx scripts/inspect-grc20.ts
 */
import { Events } from "discord.js";
import { env } from "../src/config/env.js";
import { createClient } from "../src/core/client.js";
import { logger } from "../src/core/logger.js";
import { prisma } from "../src/core/db.js";

const KEY = process.env.KEY ?? "grc-20";

async function main() {
  const client = createClient();
  client.once(Events.ClientReady, async (c) => {
    const guild = await (await c.guilds.fetch(env.DISCORD_GUILD_ID)).fetch();
    await guild.roles.fetch();
    await guild.members.fetch();

    const grcRoles = guild.roles.cache.filter((r) => /grc|GRC/i.test(r.name));
    logger.info(
      { roles: grcRoles.map((r) => `${r.name} (${r.members.size})`).sort() },
      "GRC-ish roles in guild (name + member count)"
    );

    const rows = await prisma.member.findMany({
      where: { guildId: guild.id, project: KEY },
      select: { id: true, displayName: true, module: true, pod: true },
    });
    logger.info({ key: KEY, count: rows.length }, "DB members on project");

    const missing: string[] = [];
    for (const r of rows) {
      const m = guild.members.cache.get(r.id);
      if (!m) {
        missing.push(`${r.displayName ?? r.id} — NOT IN GUILD`);
        continue;
      }
      const held = m.roles.cache.map((x) => x.name).filter((n) => /grc|GRC/i.test(n));
      logger.info(
        { member: r.displayName ?? m.user.tag, dbModule: r.module, dbPod: r.pod, held },
        "member"
      );
    }
    if (missing.length) logger.warn({ missing }, "unresolved");

    await prisma.$disconnect();
    client.destroy();
    process.exit(0);
  });
  await client.login(env.DISCORD_TOKEN);
}
main().catch((err) => {
  logger.error({ err }, "inspect-grc20 fatal");
  process.exit(1);
});
