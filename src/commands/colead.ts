import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import type { SlashCommand } from "../core/registry.js";
import { canManageLeadership } from "../lib/rbac.js";
import { activeProjects } from "../config/loader.js";
import { assignLead, listLeads, removeLead } from "../services/leadership.js";

const projectChoices = () =>
  activeProjects()
    .slice(0, 25)
    .map((p) => ({ name: p.name, value: p.key }));

export const colead: SlashCommand = {
  get data() {
    return new SlashCommandBuilder()
    .setName("colead")
    .setDescription("Manage Co-Leads")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setDMPermission(false)
    .addSubcommand((sc) =>
      sc
        .setName("assign")
        .setDescription("Assign Co-Lead for a specific pod")
        .addUserOption((o) =>
          o.setName("member").setDescription("Member").setRequired(true)
        )
        .addStringOption((o) =>
          o
            .setName("project")
            .setDescription("Project")
            .setRequired(true)
            .addChoices(...projectChoices())
        )
        .addIntegerOption((o) =>
          o
            .setName("module")
            .setDescription("Module number")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(20)
        )
        .addIntegerOption((o) =>
          o
            .setName("pod")
            .setDescription("Pod number")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(20)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("remove")
        .setDescription("Remove Co-Lead role")
        .addUserOption((o) =>
          o.setName("member").setDescription("Member").setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("transfer")
        .setDescription("Move Co-Lead from one member to another")
        .addUserOption((o) =>
          o.setName("from").setDescription("Current colead").setRequired(true)
        )
        .addUserOption((o) =>
          o.setName("to").setDescription("New colead").setRequired(true)
        )
        .addStringOption((o) =>
          o
            .setName("project")
            .setDescription("Project")
            .setRequired(true)
            .addChoices(...projectChoices())
        )
        .addIntegerOption((o) =>
          o
            .setName("module")
            .setDescription("Module number")
            .setRequired(true)
            .setMinValue(1)
        )
        .addIntegerOption((o) =>
          o.setName("pod").setDescription("Pod number").setRequired(true).setMinValue(1)
        )
    )
    .addSubcommand((sc) =>
      sc.setName("list").setDescription("List current Co-Leads")
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
      const members = listLeads(interaction.guild, "Co-Lead");
      const list =
        members.length === 0
          ? "No Co-Leads."
          : members.map((m) => `- <@${m.id}>`).join("\n");
      await interaction.reply({ content: list, flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === "assign") {
      const user = interaction.options.getUser("member", true);
      const projectKey = interaction.options.getString("project", true);
      const moduleNum = interaction.options.getInteger("module", true);
      const podNum = interaction.options.getInteger("pod", true);
      const target = await interaction.guild.members.fetch(user.id);
      const applied = await assignLead({
        kind: "Co-Lead",
        member: target,
        projectKey,
        moduleNum,
        podNum,
        actor,
      });
      await interaction.reply({
        content: `Assigned Co-Lead to <@${target.id}>. Roles: ${applied.join(", ")}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "remove") {
      const user = interaction.options.getUser("member", true);
      const target = await interaction.guild.members.fetch(user.id);
      await removeLead(target, "Co-Lead", actor);
      await interaction.reply({
        content: `Removed Co-Lead from <@${target.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "transfer") {
      const fromUser = interaction.options.getUser("from", true);
      const toUser = interaction.options.getUser("to", true);
      const projectKey = interaction.options.getString("project", true);
      const moduleNum = interaction.options.getInteger("module", true);
      const podNum = interaction.options.getInteger("pod", true);
      const from = await interaction.guild.members.fetch(fromUser.id);
      const to = await interaction.guild.members.fetch(toUser.id);
      await removeLead(from, "Co-Lead", actor);
      const applied = await assignLead({
        kind: "Co-Lead",
        member: to,
        projectKey,
        moduleNum,
        podNum,
        actor,
      });
      await interaction.reply({
        content: `Transferred Co-Lead: <@${from.id}> → <@${to.id}>. Roles: ${applied.join(", ")}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  },
};
