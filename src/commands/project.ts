import {
  ActionRowBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from "discord.js";
import type { SlashCommand } from "../core/registry.js";
import { isFounder, isStaff } from "../lib/rbac.js";
import { org } from "../config/loader.js";
import {
  archiveProject,
  createProject,
  dissolveProject,
  renameProject,
  restoreFromBackup,
} from "../services/projectMgmt.js";
import { assignLead } from "../services/leadership.js";

export const PROJECT_WIZARD_ID = "project:wizard";

export function projectWizardModal(): ModalBuilder {
  const field = (id: string, label: string, ph: string, style = TextInputStyle.Short) =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId(id)
        .setLabel(label)
        .setPlaceholder(ph)
        .setStyle(style)
        .setRequired(true)
    );
  return new ModalBuilder()
    .setCustomId(PROJECT_WIZARD_ID)
    .setTitle("New Project")
    .addComponents(
      field("name", "Display name", "e.g. CyGRC"),
      field("key", "Short key (no spaces)", "e.g. cygrc"),
      field("modules", "Number of modules", "e.g. 4"),
      field("pods", "Pods per module", "e.g. 4")
    );
}

const projectChoices = () =>
  org.projects.slice(0, 25).map((p) => ({ name: p.name, value: p.key }));

export const project: SlashCommand = {
  get data() {
    return new SlashCommandBuilder()
    .setName("project")
    .setDescription("Manage projects")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((sc) =>
      sc
        .setName("create")
        .setDescription("Create a new project")
        .addStringOption((o) => o.setName("key").setDescription("Short key, e.g. ai-siem").setRequired(true))
        .addStringOption((o) => o.setName("name").setDescription("Display name").setRequired(true))
        .addIntegerOption((o) =>
          o.setName("modules").setDescription("Number of modules").setRequired(true).setMinValue(0).setMaxValue(20)
        )
        .addIntegerOption((o) =>
          o.setName("pods").setDescription("Pods per module").setRequired(true).setMinValue(0).setMaxValue(20)
        )
        .addUserOption((o) =>
          o.setName("team_lead").setDescription("Auto-assign this member as Team Lead")
        )
    )
    .addSubcommand((sc) =>
      sc.setName("wizard").setDescription("Create a project via a guided form")
    )
    .addSubcommand((sc) =>
      sc
        .setName("rename")
        .setDescription("Rename a project")
        .addStringOption((o) =>
          o.setName("project").setDescription("Project").setRequired(true).addChoices(...projectChoices())
        )
        .addStringOption((o) => o.setName("new_name").setDescription("New display name").setRequired(true))
    )
    .addSubcommand((sc) =>
      sc
        .setName("archive")
        .setDescription("Archive a project (lock + move to ARCHIVE)")
        .addStringOption((o) =>
          o.setName("project").setDescription("Project").setRequired(true).addChoices(...projectChoices())
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("dissolve")
        .setDescription("Backup + delete a project (DESTRUCTIVE)")
        .addStringOption((o) =>
          o.setName("project").setDescription("Project").setRequired(true).addChoices(...projectChoices())
        )
        .addStringOption((o) =>
          o.setName("confirm").setDescription("Type the project key to confirm").setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("restore")
        .setDescription("Restore a project from backup file")
        .addStringOption((o) =>
          o.setName("backup_file").setDescription("Absolute path to backup JSON").setRequired(true)
        )
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

    const sub = interaction.options.getSubcommand();

    if (sub === "wizard") {
      await interaction.showModal(projectWizardModal());
      return;
    }

    if (sub === "create") {
      const key = interaction.options.getString("key", true);
      const name = interaction.options.getString("name", true);
      const modules = interaction.options.getInteger("modules", true);
      const pods = interaction.options.getInteger("pods", true);
      const teamLead = interaction.options.getUser("team_lead");
      await interaction.reply({ content: "Creating project...", flags: MessageFlags.Ephemeral });
      await createProject(interaction.guild, {
        key,
        name,
        modules,
        podsPerModule: pods,
        active: true,
      });
      let extra = "";
      if (teamLead) {
        const member = await interaction.guild.members.fetch(teamLead.id);
        await assignLead({ kind: "Team Lead", member, projectKey: key, actor });
        extra = ` Team Lead <@${teamLead.id}> assigned.`;
      }
      await interaction.editReply(`Project '${name}' created.${extra}`);
      return;
    }

    if (sub === "rename") {
      const key = interaction.options.getString("project", true);
      const newName = interaction.options.getString("new_name", true);
      await interaction.reply({ content: "Renaming...", flags: MessageFlags.Ephemeral });
      await renameProject(interaction.guild, key, newName);
      await interaction.editReply(`Renamed to '${newName}'.`);
      return;
    }

    if (sub === "archive") {
      const key = interaction.options.getString("project", true);
      await interaction.reply({ content: "Archiving...", flags: MessageFlags.Ephemeral });
      await archiveProject(interaction.guild, key);
      await interaction.editReply(`Project '${key}' archived.`);
      return;
    }

    if (sub === "dissolve") {
      if (!isFounder(actor)) {
        await interaction.reply({ content: "Founder only.", flags: MessageFlags.Ephemeral });
        return;
      }
      const key = interaction.options.getString("project", true);
      const confirm = interaction.options.getString("confirm", true);
      if (confirm !== key) {
        await interaction.reply({
          content: `Confirmation mismatch. Type the project key '${key}' exactly.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.reply({ content: "Dissolving...", flags: MessageFlags.Ephemeral });
      const backup = await dissolveProject(interaction.guild, key);
      await interaction.editReply(`Dissolved. Backup: \`${backup}\``);
      return;
    }

    if (sub === "restore") {
      if (!isFounder(actor)) {
        await interaction.reply({ content: "Founder only.", flags: MessageFlags.Ephemeral });
        return;
      }
      const file = interaction.options.getString("backup_file", true);
      await interaction.reply({ content: "Restoring...", flags: MessageFlags.Ephemeral });
      await restoreFromBackup(interaction.guild, file);
      await interaction.editReply("Restored.");
      return;
    }
  },
};
