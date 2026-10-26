import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type TextChannel,
  MessageFlags,
} from "discord.js";
import type { SlashCommand } from "../core/registry.js";
import { hasAdminRole, isStaff } from "../lib/rbac.js";
import { activeProjects, findProject, org } from "../config/loader.js";
import { roleNames, placeNames } from "../lib/names.js";

const TARGETS = [
  { name: "Entire org", value: "org" },
  { name: "Project", value: "project" },
  { name: "Module", value: "module" },
  { name: "Pod", value: "pod" },
  { name: "Batch", value: "batch" },
] as const;

const projectChoices = () =>
  activeProjects()
    .slice(0, 25)
    .map((p) => ({ name: p.name, value: p.key }));

const batchChoices = () =>
  org.batches.slice(0, 25).map((b) => ({ name: b, value: b }));

export const announce: SlashCommand = {
  get data() {
    return new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Publish an announcement")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false)
    .addStringOption((o) =>
      o
        .setName("target")
        .setDescription("Audience")
        .setRequired(true)
        .addChoices(...TARGETS)
    )
    .addStringOption((o) =>
      o.setName("message").setDescription("Message body").setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("project")
        .setDescription("Project key (for project/module/pod)")
        .addChoices(...projectChoices())
    )
    .addIntegerOption((o) =>
      o.setName("module").setDescription("Module number").setMinValue(1)
    )
    .addIntegerOption((o) =>
      o.setName("pod").setDescription("Pod number").setMinValue(1)
    )
    .addStringOption((o) =>
      o
        .setName("batch")
        .setDescription("Batch name")
        .addChoices(...batchChoices())
    );
  },
  async execute(interaction) {
    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral });
      return;
    }
    const actor = await interaction.guild.members.fetch(interaction.user.id);
    const target = interaction.options.getString("target", true);
    const message = interaction.options.getString("message", true);

    const canOrgWide = isStaff(actor) || hasAdminRole(actor, "Founder", "Manager", "HR");
    const canProjectWide =
      canOrgWide || actor.roles.cache.some((r) => r.name === "Team Lead");

    if (target === "org" && !canOrgWide) {
      await interaction.reply({ content: "Only Founder/Manager/HR can org-wide.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (target !== "org" && !canProjectWide) {
      await interaction.reply({ content: "Need Team Lead or higher.", flags: MessageFlags.Ephemeral });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("Announcement")
      .setDescription(message)
      .setColor(0x57f287)
      .setFooter({ text: `From ${actor.displayName}` })
      .setTimestamp(new Date());

    const sent: string[] = [];

    const findText = (name: string, parent?: string) =>
      interaction.guild.channels.cache.find(
        (c) =>
          c.type === ChannelType.GuildText &&
          c.name === name &&
          (parent ? c.parent?.name === parent : true)
      ) as TextChannel | undefined;

    if (target === "org") {
      const ch = findText("announcements", org.categories.information.name);
      if (ch) {
        await ch.send({ embeds: [embed] });
        sent.push(`#${ch.name}`);
      }
    } else if (target === "project") {
      const key = interaction.options.getString("project", true);
      const p = findProject(key);
      if (!p) {
        await interaction.reply({ content: "Unknown project.", flags: MessageFlags.Ephemeral });
        return;
      }
      const ch = findText("announcements", placeNames.projectCategory(p));
      if (ch) {
        const role = interaction.guild.roles.cache.find((r) => r.name === roleNames.project(p));
        await ch.send({
          content: role ? `<@&${role.id}>` : undefined,
          embeds: [embed],
        });
        sent.push(`#${ch.name}`);
      }
    } else if (target === "module") {
      const key = interaction.options.getString("project", true);
      const moduleNum = interaction.options.getInteger("module", true);
      const p = findProject(key);
      if (!p) {
        await interaction.reply({ content: "Unknown project.", flags: MessageFlags.Ephemeral });
        return;
      }
      const projectAnn = findText("announcements", placeNames.projectCategory(p));
      const role = interaction.guild.roles.cache.find(
        (r) => r.name === roleNames.module(p, moduleNum)
      );
      if (projectAnn) {
        await projectAnn.send({
          content: role ? `<@&${role.id}>` : undefined,
          embeds: [embed],
        });
        sent.push(`#${projectAnn.name}`);
      }
    } else if (target === "pod") {
      const key = interaction.options.getString("project", true);
      const moduleNum = interaction.options.getInteger("module", true);
      const podNum = interaction.options.getInteger("pod", true);
      const p = findProject(key);
      if (!p) {
        await interaction.reply({ content: "Unknown project.", flags: MessageFlags.Ephemeral });
        return;
      }
      const role = interaction.guild.roles.cache.find(
        (r) => r.name === roleNames.pod(p, moduleNum, podNum)
      );
      const chatName = `${p.key}-m${moduleNum}-p${podNum}-chat`;
      const ch = findText(chatName);
      if (ch) {
        await ch.send({
          content: role ? `<@&${role.id}>` : undefined,
          embeds: [embed],
        });
        sent.push(`#${ch.name}`);
      }
    } else if (target === "batch") {
      const batch = interaction.options.getString("batch", true);
      const orgAnn = findText("announcements", org.categories.information.name);
      const role = interaction.guild.roles.cache.find((r) => r.name === batch);
      if (orgAnn) {
        await orgAnn.send({
          content: role ? `<@&${role.id}>` : undefined,
          embeds: [embed],
        });
        sent.push(`#${orgAnn.name}`);
      }
    }

    await interaction.reply({
      content: sent.length > 0 ? `Sent to: ${sent.join(", ")}` : "No matching channel found.",
      flags: MessageFlags.Ephemeral,
    });
  },
};
