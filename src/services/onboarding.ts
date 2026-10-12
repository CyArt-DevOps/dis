import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  GuildMember,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { activeProjects, findProject, org } from "../config/loader.js";
import { roleNames, moduleLabel } from "../lib/names.js";
import { logger } from "../core/logger.js";
import { prisma } from "../core/db.js";
import { logEmbed, postLog } from "../lib/log.js";

export const IDS = {
  begin: "onboard:begin",
  name: "onboard:name", // full-name modal
  batch: "onboard:batch",
  project: "onboard:project",
  module: "onboard:module",
  pod: "onboard:pod",
} as const;

export function welcomeEmbed(member: GuildMember): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Welcome")
    .setDescription(
      `Hi <@${member.id}>, please click **Begin Verification** to select your batch, project, module, and pod. Channels will become visible once verification is complete.`
    )
    .setColor(0x5865f2);
}

export function beginButton() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.begin)
      .setLabel("Begin Verification")
      .setStyle(ButtonStyle.Primary)
  );
}

export function nameModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(IDS.name)
    .setTitle("Registration: Step 1 of 5")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("fullName")
          .setLabel("Full Name")
          .setPlaceholder("e.g. John Smith")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(3)
          .setMaxLength(100)
      )
    );
}

/** Validate a full name: 3–100 chars, letters/spaces/hyphens/periods only. */
export function validateFullName(
  raw: string
): { ok: true; value: string } | { ok: false; reason: string } {
  const value = raw.trim().replace(/\s+/g, " ");
  if (value.length < 3) return { ok: false, reason: "Name must be at least 3 characters." };
  if (value.length > 100) return { ok: false, reason: "Name must be at most 100 characters." };
  // Allow Unicode letters, spaces, hyphens, periods only — no emoji/symbols/digits.
  if (!/^[\p{L} .\-]+$/u.test(value)) {
    return {
      ok: false,
      reason: "Only letters, spaces, hyphens, and periods are allowed.",
    };
  }
  return { ok: true, value };
}

/**
 * Persist the full name as a pending registration. Flags (but does not block)
 * duplicate names for HR review.
 */
export async function savePendingName(
  member: GuildMember,
  fullName: string
): Promise<{ duplicate: boolean }> {
  const dup = await prisma.member.findFirst({
    where: {
      guildId: member.guild.id,
      fullName: { equals: fullName },
      id: { not: member.id },
    },
  });
  const duplicate = !!dup;

  await prisma.member.upsert({
    where: { id: member.id },
    create: {
      id: member.id,
      guildId: member.guild.id,
      tag: member.user.tag,
      displayName: member.displayName,
      fullName,
      verificationStatus: "pending",
      flagged: duplicate,
    },
    update: {
      fullName,
      displayName: member.displayName,
      flagged: duplicate,
      verificationStatus: "pending",
    },
  });

  if (duplicate) {
    await postLog(
      member.guild,
      "audit",
      logEmbed("Duplicate name flagged", 0xfaa61a)
        .setDescription(
          `<@${member.id}> registered as **${fullName}**, which matches an existing member. Flagged for HR review (not blocked).`
        )
    );
  }
  return { duplicate };
}

export function buildNickname(fullName: string, projectName: string): string {
  const nick = org.nicknameFormat
    .replace("{fullName}", fullName)
    .replace("{project}", projectName);
  return nick.slice(0, 32); // Discord nickname hard limit
}

export function batchMenu() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(IDS.batch)
    .setPlaceholder("Select your batch")
    .addOptions(
      org.batches.map((b) =>
        new StringSelectMenuOptionBuilder().setLabel(b).setValue(b)
      )
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export function projectMenu(batch: string) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${IDS.project}:${encodeURIComponent(batch)}`)
    .setPlaceholder("Select your project")
    .addOptions(
      activeProjects().map((p) =>
        new StringSelectMenuOptionBuilder().setLabel(p.name).setValue(p.key)
      )
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export function moduleMenu(batch: string, projectKey: string) {
  const p = findProject(projectKey);
  if (!p) throw new Error(`Unknown project ${projectKey}`);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${IDS.module}:${encodeURIComponent(batch)}:${projectKey}`)
    .setPlaceholder("Select your module")
    .addOptions(
      Array.from({ length: p.modules }, (_, i) => {
        const m = i + 1;
        return new StringSelectMenuOptionBuilder()
          .setLabel(moduleLabel(p, m))
          .setValue(String(m));
      })
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export function podMenu(batch: string, projectKey: string, moduleNum: number) {
  const p = findProject(projectKey);
  if (!p) throw new Error(`Unknown project ${projectKey}`);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(
      `${IDS.pod}:${encodeURIComponent(batch)}:${projectKey}:${moduleNum}`
    )
    .setPlaceholder("Select your pod")
    .addOptions(
      Array.from({ length: p.podsPerModule }, (_, i) => {
        const pd = i + 1;
        return new StringSelectMenuOptionBuilder()
          .setLabel(`Pod ${pd}`)
          .setValue(String(pd));
      })
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export interface Assignment {
  batch: string;
  projectKey: string;
  moduleNum?: number; // omitted for projects without modules
  podNum?: number; // omitted for modules without pods
}

/** True if the member has already completed verification (holds the Intern role). */
export function isVerified(member: GuildMember): boolean {
  return member.roles.cache.some((r) => r.name === roleNames.intern());
}

/** Every batch/project/module/pod role name the org can produce. */
function allMembershipRoleNames(): Set<string> {
  const s = new Set<string>();
  for (const b of org.batches) s.add(b);
  for (const p of org.projects) {
    s.add(p.name);
    for (let m = 1; m <= p.modules; m++) {
      s.add(roleNames.module(p, m));
      for (let pd = 1; pd <= p.podsPerModule; pd++) {
        s.add(roleNames.pod(p, m, pd));
      }
    }
  }
  return s;
}

export async function assignRoles(
  member: GuildMember,
  a: Assignment
): Promise<{ assigned: string[]; missing: string[] }> {
  const p = findProject(a.projectKey);
  if (!p) throw new Error(`Unknown project ${a.projectKey}`);

  const wanted = [
    roleNames.intern(),
    roleNames.batch(a.batch),
    roleNames.project(p),
  ];
  if (a.moduleNum) wanted.push(roleNames.module(p, a.moduleNum));
  if (a.moduleNum && a.podNum) wanted.push(roleNames.pod(p, a.moduleNum, a.podNum));
  const wantedSet = new Set(wanted);

  // Enforce single membership: strip any other batch/project/module/pod role the
  // member already holds, so they only ever belong to one pod/module/project/batch.
  const membership = allMembershipRoleNames();
  const stale = member.roles.cache.filter(
    (r) => membership.has(r.name) && !wantedSet.has(r.name)
  );
  for (const r of stale.values()) {
    await member.roles.remove(r, "Onboarding: single-membership cleanup").catch(() => {});
  }

  const assigned: string[] = [];
  const missing: string[] = [];
  for (const name of wanted) {
    const role = member.guild.roles.cache.find((r) => r.name === name);
    if (!role) {
      missing.push(name);
      continue;
    }
    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role, "Onboarding assignment");
    }
    assigned.push(name);
  }
  // Persist the full registration profile and set the nickname.
  const existing = await prisma.member.findUnique({ where: { id: member.id } });
  const fullName = existing?.fullName ?? member.displayName;
  await prisma.member.upsert({
    where: { id: member.id },
    create: {
      id: member.id,
      guildId: member.guild.id,
      tag: member.user.tag,
      displayName: member.displayName,
      fullName,
      batch: a.batch,
      project: p.name,
      module: a.moduleNum ?? null,
      pod: a.podNum ?? null,
      registrationDate: new Date(),
      verificationStatus: "verified",
    },
    update: {
      batch: a.batch,
      project: p.name,
      module: a.moduleNum ?? null,
      pod: a.podNum ?? null,
      registrationDate: existing?.registrationDate ?? new Date(),
      verificationStatus: "verified",
    },
  });

  // Rename to "Full Name | Project" (configurable). Owner cannot be renamed.
  try {
    await member.setNickname(buildNickname(fullName, p.name), "Onboarding");
  } catch {
    logger.debug({ user: member.id }, "Could not set nickname (hierarchy/owner)");
  }

  logger.info({ user: member.id, assigned, missing }, "Onboarding assignment done");
  return { assigned, missing };
}
