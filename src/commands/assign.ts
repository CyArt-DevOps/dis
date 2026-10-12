import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import type { SlashCommand } from "../core/registry.js";
import { isStaff } from "../lib/rbac.js";
import { activeProjects, findProject, org } from "../config/loader.js";
import { assignRoles } from "../services/onboarding.js";

const projectChoices = () =>
  activeProjects().slice(0, 25).map((p) => ({ name: p.name, value: p.key }));
const batchChoices = () =>
  org.batches.slice(0, 25).map((b) => ({ name: b, value: b }));

export const assign: SlashCommand = {
  get data() {
    return new SlashCommandBuilder()
    .setName("assign")
    .setDescription("Manually assign a member to a batch/project/module/pod")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setDMPermission(false)
    .addUserOption((o) =>
      o.setName("member").setDescription("Member to assign").setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("batch").setDescription("Batch").setRequired(true).addChoices(...batchChoices())
    )
    .addStringOption((o) =>
      o.setName("project").setDescription("Project").setRequired(true).addChoices(...projectChoices())
    )
    .addIntegerOption((o) =>
      o.setName("module").setDescription("Module number (if the project has modules)").setMinValue(1).setMaxValue(20)
    )
    .addIntegerOption((o) =>
      o.setName("pod").setDescription("Pod number (if the module has pods)").setMinValue(1).setMaxValue(20)
    );
  },
  async execute(interaction) {
    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral });
      return;
    }
    const actor = await interaction.guild.members.fetch(interaction.user.id);
    if (!isStaff(actor)) {
      await interaction.reply({ content: "Staff only.", flags: MessageFlags.Ephemeral });
      return;
    }

    const user = interaction.options.getUser("member", true);
    const batch = interaction.options.getString("batch", true);
    const projectKey = interaction.options.getString("project", true);
    const moduleNum = interaction.options.getInteger("module") ?? undefined;
    const podNum = interaction.options.getInteger("pod") ?? undefined;

    const p = findProject(projectKey);
    if (!p) {
      await interaction.reply({ content: "Unknown project.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (p.modules > 0 && !moduleNum) {
      await interaction.reply({
        content: `${p.name} has modules — please provide a \`module\` (1–${p.modules}).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (moduleNum && moduleNum > p.modules) {
      await interaction.reply({
        content: `Invalid module for ${p.name} (has ${p.modules} modules).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (p.podsPerModule > 0 && moduleNum && !podNum) {
      await interaction.reply({
        content: `${p.name} modules have pods — please provide a \`pod\` (1–${p.podsPerModule}).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (podNum && podNum > p.podsPerModule) {
      await interaction.reply({
        content: `Invalid pod for ${p.name} (has ${p.podsPerModule} pods per module).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const target = await interaction.guild.members.fetch(user.id);
    const result = await assignRoles(target, { batch, projectKey, moduleNum, podNum });
    const missing =
      result.missing.length > 0
        ? `\nMissing roles (run /setup): ${result.missing.join(", ")}`
        : "";
    await interaction.reply({
      content: `Assigned <@${target.id}>:\n- ${result.assigned.join("\n- ")}${missing}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
