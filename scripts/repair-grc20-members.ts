/**
 * Members who registered while grc-20's display name was "CyGRC 2.0" ended up
 * with that string in the DB (Member.project stores the display name, not the
 * key) and, in some cases, no project roles at all.
 *
 * For every DB row with project "CyGRC 2.0": add the "GRC 2" project role and
 * the "GRC 2 Module <n>" role from the stored module, then rewrite the DB row
 * to "GRC 2". Members who already hold the roles are left alone.
 *
 *   npx tsx scripts/repair-grc20-members.ts             # report only
 *   CONFIRM=1 npx tsx scripts/repair-grc20-members.ts   # apply
 */
import { Events } from "discord.js";
import { env } from "../src/config/env.js";
import { createClient } from "../src/core/client.js";
import { logger } from "../src/core/logger.js";
import { prisma } from "../src/core/db.js";

const CONFIRM = process.env.CONFIRM === "1";
const OLD_NAME = "CyGRC 2.0";
const NEW_NAME = "GRC 2";

async function main() {
  const client = createClient();
  client.once(Events.ClientReady, async (c) => {
    const guild = await (await c.guilds.fetch(env.DISCORD_GUILD_ID)).fetch();
    await guild.roles.fetch();
    await guild.members.fetch();

    const roleByName = new Map(guild.roles.cache.map((r) => [r.name, r]));
    const rows = await prisma.member.findMany({
      where: { guildId: guild.id, project: OLD_NAME },
    });

    for (const row of rows) {
      const member = guild.members.cache.get(row.id);
      if (!member) {
        logger.warn({ id: row.id, name: row.displayName }, "Not in guild — skipped");
        continue;
      }

      const want = [NEW_NAME];
      if (row.module) want.push(`${NEW_NAME} Module ${row.module}`);

      const missing = want.filter((n) => !member.roles.cache.some((r) => r.name === n));
      const ids = missing.map((n) => roleByName.get(n)?.id).filter((v): v is string => !!v);
      if (ids.length !== missing.length) {
        logger.error({ member: row.displayName, missing }, "Role does not exist in guild — skipped");
        continue;
      }

      logger.info(
        { member: row.displayName, id: row.id, module: row.module, addRoles: missing, flagged: row.flagged },
        CONFIRM ? "Repairing" : "[report] would repair"
      );

      if (!CONFIRM) continue;
      if (ids.length) {
        await member.roles
          .add(ids, "Restore GRC 2 roles after CyGRC 2.0 name drift")
          .catch((err) =>
            logger.error({ member: row.displayName, err: (err as Error).message }, "Role add failed")
          );
      }
      await prisma.member.update({ where: { id: row.id }, data: { project: NEW_NAME } });
    }

    logger.info(
      { rows: rows.length, applied: CONFIRM },
      CONFIRM ? "Repair complete" : "Report complete — re-run with CONFIRM=1 to apply"
    );
    await prisma.$disconnect();
    client.destroy();
    process.exit(0);
  });
  await client.login(env.DISCORD_TOKEN);
}
main().catch((err) => {
  logger.error({ err }, "repair-grc20-members fatal");
  process.exit(1);
});
