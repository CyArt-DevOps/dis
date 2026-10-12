/**
 * Reconcile every stored member profile (batch/project/module/pod) with the
 * member's CURRENT Discord roles. Fixes records that went stale when a Manager
 * changed someone's project/module/pod by editing roles directly — the DB
 * profile is otherwise only written by the onboarding flow, so those changes
 * never reached it (wrong Team Lead handovers, wrong dashboard grouping, etc.).
 *
 *   DRY_RUN=1 npx tsx scripts/resync-members.ts   # report mismatches only
 *   npx tsx scripts/resync-members.ts             # apply
 */
import { Events } from "discord.js";
import { env } from "../src/config/env.js";
import { createClient } from "../src/core/client.js";
import { logger } from "../src/core/logger.js";
import { prisma } from "../src/core/db.js";
import { deriveMembership } from "../src/lib/membership.js";
import { roleNames } from "../src/lib/names.js";

const DRY = process.env.DRY_RUN === "1";

async function main() {
  const client = createClient();
  client.once(Events.ClientReady, async (c) => {
    try {
      const guild = await (await c.guilds.fetch(env.DISCORD_GUILD_ID)).fetch();
      await guild.members.fetch();
      await guild.roles.fetch();

      const dbMembers = await prisma.member.findMany();
      const dbById = new Map(dbMembers.map((m) => [m.id, m]));

      let scanned = 0;
      let changed = 0;
      let noProject = 0;
      const samples: string[] = [];

      for (const member of guild.members.cache.values()) {
        if (member.user.bot) continue;
        if (!member.roles.cache.some((r) => r.name === roleNames.intern())) continue;
        scanned++;

        const { batch, project, moduleNum, podNum } = deriveMembership(member);
        if (!project) {
          noProject++;
          continue;
        }
        const cur = dbById.get(member.id);
        const next = {
          batch: batch ?? cur?.batch ?? null,
          project: project.name,
          module: moduleNum ?? null,
          pod: podNum ?? null,
        };
        const inSync =
          cur &&
          cur.project === next.project &&
          cur.batch === next.batch &&
          cur.module === next.module &&
          cur.pod === next.pod;
        if (inSync) continue;

        changed++;
        if (samples.length < 25)
          samples.push(
            `${member.displayName} (${member.id}): ` +
              `${cur ? `${cur.project ?? "—"}/M${cur.module ?? "-"}/P${cur.pod ?? "-"}` : "no-row"}` +
              ` -> ${next.project}/M${next.module ?? "-"}/P${next.pod ?? "-"}`
          );

        if (!DRY) {
          await prisma.member.upsert({
            where: { id: member.id },
            create: {
              id: member.id,
              guildId: guild.id,
              tag: member.user.tag,
              displayName: member.displayName,
              fullName: cur?.fullName ?? member.displayName,
              registrationDate: cur?.registrationDate ?? new Date(),
              verificationStatus: "verified",
              ...next,
            },
            update: next,
          });
        }
      }

      logger.info(
        { scanned, changed, noProject, applied: !DRY },
        DRY ? "Member resync dry run" : "Member resync complete"
      );
      if (samples.length) console.log("Changes:\n  " + samples.join("\n  "));
      if (changed > 25) console.log(`  …and ${changed - 25} more`);
    } catch (err) {
      logger.error({ err }, "resync-members failed");
    } finally {
      await prisma.$disconnect().catch(() => {});
      client.destroy();
      process.exit(0);
    }
  });
  await client.login(env.DISCORD_TOKEN);
}

main().catch((err) => {
  logger.error({ err }, "resync-members fatal");
  process.exit(1);
});
