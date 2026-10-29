import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import type { SlashCommand } from "../core/registry.js";
import { canManageLeadership } from "../lib/rbac.js";
import { activeProjects } from "../config/loader.js";
import { assignPodRep, listPodReps, removePodRep } from "../services/leadership.js";

// Pod Representatives (Phase 6): "<Project> M<m> P<n> Representative". EMS grants the pod powers.
const projectChoices = () =>
  activeProjects()
    .filter((p) => p.modules > 0 && p.podsPerModule > 0)
    .slice(0, 25)
    .map((p) => ({ name: p.name, value: p.key }));

export const rep: SlashCommand = {
  get data() {
    return new SlashCommandBuilder()
      .setName("rep")
      .setDescription("Manage Pod Representatives")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .setDMPermission(false)
      .addSubcommand((sc) =>
        sc
          .setName("assign")
          .setDescription("Make a member the representative of a pod")
          .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true))
          .addStringOption((o) =>
            o.setName("project").setDescription("Project").setRequired(true).addChoices(...projectChoices())
          )
          .addIntegerOption((o) =>
            o.setName("module").setDescription("Module number").setRequired(true).setMinValue(1).setMaxValue(20)
          )
          .addIntegerOption((o) =>
            o.setName("pod").setDescription("Pod number").setRequired(true).setMinValue(1).setMaxValue(20)
          )
      )
      .addSubcommand((sc) =>
        sc
          .setName("remove")
          .setDescription("Remove a Pod Representative role (all of them when no pod is given)")
          .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true))
          .addStringOption((o) =>
            o.setName("project").setDescription("Project").setRequired(false).addChoices(...projectChoices())
          )
          .addIntegerOption((o) => o.setName("module").setDescription("Module number").setRequired(false).setMinValue(1))
          .addIntegerOption((o) => o.setName("pod").setDescription("Pod number").setRequired(false).setMinValue(1))
      )
      .addSubcommand((sc) =>
        sc
          .setName("list")
          .setDescription("List Pod Representatives")
          .addStringOption((o) =>
            o.setName("project").setDescription("Project").setRequired(false).addChoices(...projectChoices())
          )
      );
  },
  async execute(interaction) {
    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral });
      return;
    }
    const actor = await interaction.guild.members.fetch(interaction.user.id);
    if (!canManageLeadership(actor)) {
      await interaction.reply({ content: "Not allowed.", flags: MessageFlags.Ephemeral });
      return;
    }
    const sub = interaction.options.getSubcommand();

    if (sub === "list") {
      const reps = listPodReps(interaction.guild, interaction.options.getString("project") ?? undefined);
      const content = reps.length
        ? reps.map((r) => `- <@${r.memberId}> — ${r.project} M${r.module} P${r.pod}`).join("\n")
        : "No Pod Representatives.";
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      return;
    }

    const user = interaction.options.getUser("member", true);
    const target = await interaction.guild.members.fetch(user.id);

    if (sub === "assign") {
      try {
        const applied = await assignPodRep({
          member: target,
          projectKey: interaction.options.getString("project", true),
          moduleNum: interaction.options.getInteger("module", true),
          podNum: interaction.options.getInteger("pod", true),
          actor,
        });
        await interaction.reply({
          content: `<@${target.id}> is now a Pod Representative. Roles: ${applied.join(", ")}`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        await interaction.reply({ content: (err as Error).message, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (sub === "remove") {
      await removePodRep({
        member: target,
        actor,
        projectKey: interaction.options.getString("project") ?? undefined,
        moduleNum: interaction.options.getInteger("module") ?? undefined,
        podNum: interaction.options.getInteger("pod") ?? undefined,
      });
      await interaction.reply({ content: `Removed Pod Representative role from <@${target.id}>.`, flags: MessageFlags.Ephemeral });
    }
  },
};
