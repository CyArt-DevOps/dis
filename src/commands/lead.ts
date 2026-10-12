import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import type { SlashCommand } from "../core/registry.js";
import { canManageLeadership } from "../lib/rbac.js";
import { activeProjects, findProject } from "../config/loader.js";
import { assignLead, listLeads, removeLead } from "../services/leadership.js";

const projectChoices = () =>
  activeProjects()
    .slice(0, 25)
    .map((p) => ({ name: p.name, value: p.key }));

export const lead: SlashCommand = {
  get data() {
    return new SlashCommandBuilder()
    .setName("lead")
    .setDescription("Manage Team Leads")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setDMPermission(false)
    .addSubcommand((sc) =>
      sc
        .setName("assign")
        .setDescription("Assign Team Lead to a member for a project")
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
    )
    .addSubcommand((sc) =>
      sc
        .setName("remove")
        .setDescription("Remove Team Lead role from a member")
        .addUserOption((o) =>
          o.setName("member").setDescription("Member").setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("transfer")
        .setDescription("Move Team Lead from one member to another")
        .addUserOption((o) =>
          o.setName("from").setDescription("Current lead").setRequired(true)
        )
        .addUserOption((o) =>
          o.setName("to").setDescription("New lead").setRequired(true)
        )
        .addStringOption((o) =>
          o
            .setName("project")
            .setDescription("Project")
            .setRequired(true)
            .addChoices(...projectChoices())
        )
    )
    .addSubcommand((sc) =>
      sc.setName("list").setDescription("List current Team Leads")
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
      const members = listLeads(interaction.guild, "Team Lead");
      const list =
        members.length === 0
          ? "No Team Leads."
          : members.map((m) => `- <@${m.id}>`).join("\n");
      await interaction.reply({ content: list, flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === "assign") {
      const user = interaction.options.getUser("member", true);
      const projectKey = interaction.options.getString("project", true);
      const target = await interaction.guild.members.fetch(user.id);
      const applied = await assignLead({
        kind: "Team Lead",
        member: target,
        projectKey,
        actor,
      });
      await interaction.reply({
        content: `Assigned Team Lead to <@${target.id}>. Roles: ${applied.join(", ")}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "remove") {
      const user = interaction.options.getUser("member", true);
      const target = await interaction.guild.members.fetch(user.id);
      await removeLead(target, "Team Lead", actor);
      await interaction.reply({
        content: `Removed Team Lead from <@${target.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "transfer") {
      const fromUser = interaction.options.getUser("from", true);
      const toUser = interaction.options.getUser("to", true);
      const projectKey = interaction.options.getString("project", true);
      if (!findProject(projectKey)) {
        await interaction.reply({ content: "Unknown project.", flags: MessageFlags.Ephemeral });
        return;
      }
      const from = await interaction.guild.members.fetch(fromUser.id);
      const to = await interaction.guild.members.fetch(toUser.id);
      await removeLead(from, "Team Lead", actor);
      const applied = await assignLead({
        kind: "Team Lead",
        member: to,
        projectKey,
        actor,
      });
      await interaction.reply({
        content: `Transferred Team Lead: <@${from.id}> → <@${to.id}>. Roles: ${applied.join(", ")}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  },
};
