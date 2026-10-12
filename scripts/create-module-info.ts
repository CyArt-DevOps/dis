/**
 * Create a read-only `#<key>-mN-info` channel for every module of every
 * pod-based project (podsPerModule > 0). Pod-based modules otherwise have no
 * module-wide text channel, so module-scoped meeting reminders had nowhere to
 * land. The whole module can read it; Team Lead + admins can post; the meeting
 * scheduler now routes module notifications here.
 *
 * Idempotent — skips channels that already exist.
 *
 *   DRY_RUN=1 npx tsx scripts/create-module-info.ts   # report only
 *   npx tsx scripts/create-module-info.ts             # create
 */
import {
  CategoryChannel,
  ChannelType,
  Events,
  Guild,
  OverwriteResolvable,
  PermissionFlagsBits,
} from "discord.js";
import { env } from "../src/config/env.js";
import { createClient } from "../src/core/client.js";
import { logger } from "../src/core/logger.js";
import { activeProjects, org } from "../src/config/loader.js";
import { moduleShort, roleNames } from "../src/lib/names.js";

const F = PermissionFlagsBits;
const DRY = process.env.DRY_RUN === "1";

function roleId(guild: Guild, name: string): string | undefined {
  return guild.roles.cache.find((r) => r.name === name)?.id;
}

async function main() {
  const client = createClient();
  client.once(Events.ClientReady, async (c) => {
    try {
      const guild = await (await c.guilds.fetch(env.DISCORD_GUILD_ID)).fetch();
      await guild.channels.fetch();
      await guild.roles.fetch();

      const everyone = guild.roles.everyone.id;
      const adminIds = org.roles.admin
        .map((a) => roleId(guild, a))
        .filter((x): x is string => !!x);

      let created = 0;
      let existed = 0;
      const missing: string[] = [];

      for (const p of activeProjects()) {
        if (p.podsPerModule <= 0) continue; // only pod-based projects
        const teamLeadId = roleId(guild, roleNames.projectTeamLead(p));

        for (let m = 1; m <= p.modules; m++) {
          const moduleRoleId = roleId(guild, roleNames.module(p, m));
          if (!moduleRoleId) {
            missing.push(`role ${roleNames.module(p, m)}`);
            continue;
          }
          const catName = `${p.name} ${moduleShort(p, m)}`;
          const cat = guild.channels.cache.find(
            (ch) => ch.type === ChannelType.GuildCategory && ch.name === catName
          ) as CategoryChannel | undefined;
          if (!cat) {
            missing.push(`category ${catName}`);
            continue;
          }

          const name = `${p.key}-m${m}-info`;
          const exists = guild.channels.cache.find(
            (ch) =>
              ch.type === ChannelType.GuildText &&
              ch.name === name &&
              ch.parentId === cat.id
          );
          if (exists) {
            existed++;
            continue;
          }

          const overwrites: OverwriteResolvable[] = [
            { id: everyone, deny: [F.ViewChannel] },
            ...adminIds.map((id) => ({
              id,
              allow: [F.ViewChannel, F.SendMessages, F.ManageChannels],
            })),
            {
              id: moduleRoleId,
              allow: [F.ViewChannel, F.ReadMessageHistory],
              deny: [F.SendMessages],
            },
          ];
          if (teamLeadId)
            overwrites.push({
              id: teamLeadId,
              allow: [F.ViewChannel, F.SendMessages, F.ManageMessages],
            });

          if (DRY) {
            logger.info({ channel: name, category: catName }, "[dry] would create");
            created++;
            continue;
          }
          await guild.channels.create({
            name,
            type: ChannelType.GuildText,
            parent: cat.id,
            permissionOverwrites: overwrites,
            topic: `${p.name} ${moduleShort(p, m)} — module-wide info & meeting notifications`,
          });
          created++;
          logger.info({ channel: name, category: catName }, "Created module-info channel");
        }
      }

      logger.info(
        { created, existed, missing, dryRun: DRY },
        DRY ? "Module-info dry run complete" : "Module-info creation complete"
      );
      if (missing.length) logger.warn({ missing }, "Some roles/categories not found");
    } catch (err) {
      logger.error({ err }, "create-module-info failed");
    } finally {
      client.destroy();
      process.exit(0);
    }
  });
  await client.login(env.DISCORD_TOKEN);
}

main().catch((err) => {
  logger.error({ err }, "create-module-info fatal");
  process.exit(1);
});
