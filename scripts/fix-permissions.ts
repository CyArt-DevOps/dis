/**
 * Reconcile channel permission overwrites with the current org config.
 *
 * Bootstrap intentionally does NOT re-apply overwrites to existing channels
 * (see bootstrap.ts getOrCreateCategory). Servers built with older code still
 * carry the generic "Team Lead"/"Co-Lead" roles on project channels, and pod
 * channels may have lost their pod-role overwrites (e.g. via "Sync Now").
 *
 * This script:
 *  1. Re-applies the exact desired overwrites to every project category,
 *     channel, and VC (per-project lead roles, module roles, pod roles).
 *  2. Removes the generic "Team Lead"/"Co-Lead" role overwrites from EVERY
 *     channel and category in the guild.
 *
 * Run:  npm run fix:perms            (applies changes)
 *       DRY_RUN=1 npm run fix:perms  (report only, no writes)
 */
import {
  CategoryChannel,
  ChannelType,
  Events,
  Guild,
  GuildBasedChannel,
  OverwriteResolvable,
  PermissionFlagsBits,
} from "discord.js";
import { env } from "../src/config/env.js";
import { createClient } from "../src/core/client.js";
import { logger } from "../src/core/logger.js";
import { activeProjects, org, type ProjectDef } from "../src/config/loader.js";
import { channelNames, moduleShort, roleNames } from "../src/lib/names.js";

const F = PermissionFlagsBits;
const VIEW = F.ViewChannel;
const SEND = F.SendMessages;
const CONNECT = F.Connect;
const SPEAK = F.Speak;
const MANAGE_CH = F.ManageChannels;
const MANAGE_MSG = F.ManageMessages;

const DRY = process.env.DRY_RUN === "1";

let applied = 0;
let skipped = 0;
let stripped = 0;
const missing: string[] = [];

function roleId(guild: Guild, name: string): string | undefined {
  return guild.roles.cache.find((r) => r.name === name)?.id;
}

function adminIds(guild: Guild): string[] {
  return org.roles.admin
    .map((a) => roleId(guild, a))
    .filter((x): x is string => !!x);
}

function findCategory(guild: Guild, name: string): CategoryChannel | undefined {
  return guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === name
  ) as CategoryChannel | undefined;
}

function findChild(
  guild: Guild,
  parent: CategoryChannel,
  type: ChannelType,
  name: string
): GuildBasedChannel | undefined {
  return guild.channels.cache.find(
    (c) => c.type === type && c.parentId === parent.id && c.name === name
  );
}

async function setOverwrites(
  ch: GuildBasedChannel | undefined,
  label: string,
  overwrites: OverwriteResolvable[]
) {
  if (!ch) {
    missing.push(label);
    return;
  }
  if (!("permissionOverwrites" in ch)) return;
  if (DRY) {
    logger.info({ channel: ch.name }, "[dry] would set overwrites");
    applied++;
    return;
  }
  try {
    await ch.permissionOverwrites.set(overwrites, "Permission reconcile");
    applied++;
    logger.info({ channel: ch.name }, "Overwrites set");
  } catch (err) {
    logger.error({ channel: ch.name, err: (err as Error).message }, "Set failed");
  }
}

async function fixProject(guild: Guild, p: ProjectDef) {
  const admins = adminIds(guild);
  const everyone = guild.roles.everyone.id;
  const projectId = roleId(guild, roleNames.project(p));
  const pleadId = roleId(guild, roleNames.projectTeamLead(p));
  const pcoleadId = roleId(guild, roleNames.projectCoLead(p));
  if (!projectId) {
    missing.push(`role: ${roleNames.project(p)}`);
    return;
  }
  if (!pleadId) missing.push(`role: ${roleNames.projectTeamLead(p)}`);
  if (!pcoleadId) missing.push(`role: ${roleNames.projectCoLead(p)}`);

  const cat = findCategory(guild, p.name.toUpperCase());
  if (!cat) {
    missing.push(`category: ${p.name.toUpperCase()}`);
    return;
  }

  // Category (mirrors bootstrap buildProject)
  const catOverwrites: OverwriteResolvable[] = [
    { id: everyone, deny: [VIEW] },
    ...admins.map((id) => ({ id, allow: [VIEW, SEND, MANAGE_CH] })),
    { id: projectId, allow: [VIEW, SEND, CONNECT, SPEAK] },
  ];
  if (pleadId)
    catOverwrites.push({ id: pleadId, allow: [VIEW, SEND, CONNECT, SPEAK, MANAGE_CH] });
  await setOverwrites(cat, `category ${cat.name}`, catOverwrites);

  // general + announcements inherit the category
  for (const name of [channelNames.projectGeneral(), channelNames.projectAnnouncements()]) {
    const ch = findChild(guild, cat, ChannelType.GuildText, name);
    if (!ch) {
      missing.push(`${p.key}/${name}`);
      continue;
    }
    if (DRY) {
      logger.info({ channel: ch.name }, "[dry] would sync with category");
      continue;
    }
    if ("lockPermissions" in ch) await ch.lockPermissions().catch(() => {});
  }

  // support channel
  const supportOverwrites: OverwriteResolvable[] = [
    { id: everyone, deny: [VIEW] },
    ...admins.map((id) => ({ id, allow: [VIEW, SEND, MANAGE_CH] })),
    { id: projectId, allow: [VIEW] },
  ];
  if (pleadId) supportOverwrites.push({ id: pleadId, allow: [VIEW, SEND, MANAGE_MSG] });
  await setOverwrites(
    findChild(guild, cat, ChannelType.GuildText, `${p.key}-support`) ??
      findChild(guild, cat, ChannelType.GuildText, `${p.name.toLowerCase()}-support`),
    `${p.key}-support`,
    supportOverwrites
  );

  // project general VC
  const vcOverwrites: OverwriteResolvable[] = [
    { id: everyone, deny: [VIEW] },
    ...admins.map((id) => ({ id, allow: [VIEW, CONNECT, SPEAK] })),
    { id: projectId, allow: [VIEW, CONNECT, SPEAK] },
  ];
  if (pleadId) vcOverwrites.push({ id: pleadId, allow: [VIEW, CONNECT, SPEAK, MANAGE_CH] });
  await setOverwrites(
    findChild(guild, cat, ChannelType.GuildVoice, `${p.name} General VC`),
    `${p.name} General VC`,
    vcOverwrites
  );

  // leadership channels: ONLY per-project leads (+ admins)
  const leadershipOverwrites: OverwriteResolvable[] = [
    { id: everyone, deny: [VIEW] },
    ...admins.map((id) => ({ id, allow: [VIEW, SEND, CONNECT, SPEAK, MANAGE_MSG] })),
  ];
  if (pleadId) leadershipOverwrites.push({ id: pleadId, allow: [VIEW, SEND, CONNECT, SPEAK] });
  if (pcoleadId)
    leadershipOverwrites.push({ id: pcoleadId, allow: [VIEW, SEND, CONNECT, SPEAK] });

  await setOverwrites(
    findChild(guild, cat, ChannelType.GuildText, `lead-${p.key}-${channelNames.teamLeadChat()}`),
    `lead-${p.key}-team-lead-chat`,
    leadershipOverwrites
  );
  await setOverwrites(
    findChild(guild, cat, ChannelType.GuildText, `lead-${p.key}-${channelNames.coleadChat()}`),
    `lead-${p.key}-colead-chat`,
    leadershipOverwrites
  );
  await setOverwrites(
    findChild(guild, cat, ChannelType.GuildVoice, `${p.name} ${channelNames.leadershipVc()}`),
    `${p.name} Leadership VC`,
    leadershipOverwrites
  );

  // modules + pods
  for (let m = 1; m <= p.modules; m++) {
    const moduleId = roleId(guild, roleNames.module(p, m));
    if (!moduleId) {
      missing.push(`role: ${roleNames.module(p, m)}`);
      continue;
    }
    const modCat = findCategory(guild, `${p.name} ${moduleShort(p, m)}`);
    if (!modCat) {
      missing.push(`category: ${p.name} ${moduleShort(p, m)}`);
      continue;
    }

    const modCatOverwrites: OverwriteResolvable[] = [
      { id: everyone, deny: [VIEW] },
      ...admins.map((id) => ({ id, allow: [VIEW, SEND, MANAGE_CH] })),
      { id: moduleId, allow: [VIEW] },
    ];
    if (pleadId)
      modCatOverwrites.push({ id: pleadId, allow: [VIEW, SEND, CONNECT, SPEAK, MANAGE_CH] });
    await setOverwrites(modCat, `category ${modCat.name}`, modCatOverwrites);

    if (p.podsPerModule === 0) {
      const modChanOverwrites: OverwriteResolvable[] = [
        { id: everyone, deny: [VIEW] },
        ...admins.map((id) => ({ id, allow: [VIEW, SEND, MANAGE_CH] })),
        { id: moduleId, allow: [VIEW, SEND, CONNECT, SPEAK] },
      ];
      if (pleadId)
        modChanOverwrites.push({ id: pleadId, allow: [VIEW, SEND, CONNECT, SPEAK, MANAGE_CH] });
      await setOverwrites(
        findChild(guild, modCat, ChannelType.GuildText, `${p.key}-m${m}-chat`),
        `${p.key}-m${m}-chat`,
        modChanOverwrites
      );
      await setOverwrites(
        findChild(guild, modCat, ChannelType.GuildText, `${p.key}-m${m}-resources`),
        `${p.key}-m${m}-resources`,
        modChanOverwrites
      );
      await setOverwrites(
        findChild(guild, modCat, ChannelType.GuildVoice, `${p.name} ${moduleShort(p, m)} VC`),
        `${p.name} ${moduleShort(p, m)} VC`,
        modChanOverwrites
      );
    }

    for (let pd = 1; pd <= p.podsPerModule; pd++) {
      const podId = roleId(guild, roleNames.pod(p, m, pd));
      if (!podId) {
        missing.push(`role: ${roleNames.pod(p, m, pd)}`);
        continue;
      }
      const podOverwrites: OverwriteResolvable[] = [
        { id: everyone, deny: [VIEW] },
        ...admins.map((id) => ({ id, allow: [VIEW, SEND, MANAGE_CH] })),
        { id: podId, allow: [VIEW, SEND, CONNECT, SPEAK] },
      ];
      if (pleadId) podOverwrites.push({ id: pleadId, allow: [VIEW, SEND, CONNECT, SPEAK] });

      await setOverwrites(
        findChild(guild, modCat, ChannelType.GuildText, `${p.key}-m${m}-p${pd}-${channelNames.podChat()}`),
        `${p.key}-m${m}-p${pd}-chat`,
        podOverwrites
      );
      await setOverwrites(
        findChild(guild, modCat, ChannelType.GuildText, `${p.key}-m${m}-p${pd}-${channelNames.podResources()}`),
        `${p.key}-m${m}-p${pd}-resources`,
        podOverwrites
      );
      await setOverwrites(
        findChild(guild, modCat, ChannelType.GuildVoice, `${p.name} ${moduleShort(p, m)} P${pd} VC`),
        `${p.name} ${moduleShort(p, m)} P${pd} VC`,
        podOverwrites
      );
    }
  }
}

/** Remove generic Team Lead / Co-Lead overwrites from every remaining channel. */
async function stripGenericLeads(guild: Guild) {
  const genericIds = [roleNames.teamLead(), roleNames.coLead()]
    .map((n) => roleId(guild, n))
    .filter((x): x is string => !!x);
  if (genericIds.length === 0) return;

  for (const ch of guild.channels.cache.values()) {
    if (!("permissionOverwrites" in ch)) continue;
    for (const gid of genericIds) {
      if (!ch.permissionOverwrites.cache.has(gid)) continue;
      if (DRY) {
        logger.info({ channel: ch.name }, "[dry] would strip generic lead overwrite");
        stripped++;
        continue;
      }
      await ch.permissionOverwrites
        .delete(gid, "Generic lead roles no longer grant channel access")
        .then(() => {
          stripped++;
          logger.info({ channel: ch.name }, "Stripped generic lead overwrite");
        })
        .catch((err) =>
          logger.error({ channel: ch.name, err: (err as Error).message }, "Strip failed")
        );
    }
  }
}

async function main() {
  const client = createClient();
  client.once(Events.ClientReady, async (c) => {
    logger.info({ user: c.user.tag, dryRun: DRY }, "Connected; reconciling permissions");
    try {
      const guild = await c.guilds.fetch(env.DISCORD_GUILD_ID);
      const full = await guild.fetch();
      await full.channels.fetch();
      await full.roles.fetch();

      for (const p of activeProjects()) {
        logger.info({ project: p.key }, "Reconciling project");
        await fixProject(full, p);
      }
      await stripGenericLeads(full);

      logger.info(
        { applied, stripped, skipped, missing },
        DRY ? "Dry run complete" : "Permission reconcile complete"
      );
      if (missing.length > 0)
        logger.warn({ missing }, "Some roles/channels not found — check names above");
    } catch (err) {
      logger.error({ err }, "Reconcile failed");
    } finally {
      client.destroy();
      process.exit(0);
    }
  });
  await client.login(env.DISCORD_TOKEN);
}

main().catch((err) => {
  logger.error({ err }, "fix-permissions fatal");
  process.exit(1);
});
