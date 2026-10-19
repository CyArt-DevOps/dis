/**
 * Remove the members of dissolved projects from the server and mark them as
 * Former Interns (records, profile and reports are kept).
 *
 *   npx tsx scripts/remove-project-members.ts "Chain Discovery" "DF-IR"           # dry run
 *   npx tsx scripts/remove-project-members.ts "Chain Discovery" "DF-IR" --apply   # kick + mark
 *
 * Never kicks staff: anyone with an admin role (org.roles.admin), a Team Lead
 * or Co-Lead role, or Administrator / Manage Server / Kick Members permission.
 */
import { Events, PermissionFlagsBits } from "discord.js";
import { env } from "../src/config/env.js";
import { org } from "../src/config/loader.js";
import { createClient } from "../src/core/client.js";
import { connectDb, prisma } from "../src/core/db.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const projects = args.filter((a) => a !== "--apply");
if (!projects.length) {
  console.error('Usage: tsx scripts/remove-project-members.ts "Project" ["Project" ...] [--apply]');
  process.exit(1);
}

await connectDb();
const members = await prisma.member.findMany({
  where: { project: { in: projects }, status: { not: "former" } },
  select: { id: true, fullName: true, displayName: true, tag: true, project: true },
  orderBy: [{ project: "asc" }, { fullName: "asc" }],
});

const client = createClient();
client.once(Events.ClientReady, async (c) => {
  const guild = await (await c.guilds.fetch(env.DISCORD_GUILD_ID)).fetch();
  const staffRoleNames = new Set([...org.roles.admin, "Team Lead", "Co-Lead"]);
  const rows: { id: string; name: string; project: string; action: string }[] = [];

  for (const m of members) {
    const name = m.fullName ?? m.displayName ?? m.tag ?? m.id;
    const gm = await guild.members.fetch(m.id).catch(() => null);
    let action: string;
    if (!gm) action = "not in server: mark former";
    else if (gm.user.bot) action = "SKIP (bot)";
    else if (
      gm.roles.cache.some((r) => staffRoleNames.has(r.name) || /Team Lead|Co-Lead/.test(r.name)) ||
      gm.permissions.has(PermissionFlagsBits.Administrator) ||
      gm.permissions.has(PermissionFlagsBits.ManageGuild) ||
      gm.permissions.has(PermissionFlagsBits.KickMembers)
    )
      action = "SKIP (staff)";
    else if (!gm.kickable) action = "SKIP (bot can't kick: role position)";
    else action = "kick + mark former";

    if (apply && (action.startsWith("kick") || action.startsWith("not in server"))) {
      const reason = `Project ${m.project} dissolved`;
      if (gm && action.startsWith("kick")) {
        try {
          await gm.kick(reason);
        } catch (err) {
          action = `FAILED kick: ${(err as Error).message}`;
        }
      }
      if (!action.startsWith("FAILED")) {
        await prisma.member.update({
          where: { id: m.id },
          data: { status: "former", formerAt: new Date(), formerReason: `${reason}; removed from the server` },
        });
        action = action.startsWith("kick") ? "KICKED, marked former" : "marked former (already left)";
      }
    }
    rows.push({ id: m.id, name, project: m.project ?? "", action });
  }

  console.log(`${apply ? "APPLIED" : "DRY RUN"}: ${rows.length} member(s) on ${projects.join(", ")}\n`);
  for (const r of rows) console.log(`${r.project.padEnd(16)} ${r.name.padEnd(34)} ${r.id.padEnd(20)} ${r.action}`);
  const tally = rows.reduce<Record<string, number>>((a, r) => ((a[r.action] = (a[r.action] ?? 0) + 1), a), {});
  console.log("\n" + JSON.stringify(tally, null, 1));
  client.destroy();
  process.exit(0);
});
await client.login(env.DISCORD_TOKEN);
