import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import type { SlashCommand } from "../core/registry.js";
import { canManageLeadership } from "../lib/rbac.js";
import { activeProjects, org } from "../config/loader.js";
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
      await interaction.reply({ content: formatRepList(reps), flags: MessageFlags.Ephemeral });
      return;
    }

    // Role edits + audit log can take a while; acknowledge within Discord's 3 s window.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const user = interaction.options.getUser("member", true);
      const target = await interaction.guild.members.fetch(user.id);

      if (sub === "assign") {
        const applied = await assignPodRep({
          member: target,
          projectKey: interaction.options.getString("project", true),
          moduleNum: interaction.options.getInteger("module", true),
          podNum: interaction.options.getInteger("pod", true),
          actor,
        });
        await interaction.editReply(`<@${target.id}> is now a Pod Representative. Roles: ${applied.join(", ")}`);
        return;
      }

      if (sub === "remove") {
        const { removed, failed } = await removePodRep({
          member: target,
          actor,
          projectKey: interaction.options.getString("project") ?? undefined,
          moduleNum: interaction.options.getInteger("module") ?? undefined,
          podNum: interaction.options.getInteger("pod") ?? undefined,
        });
        const lines: string[] = [];
        if (removed.length) lines.push(`Removed: ${removed.join(", ")}`);
        if (failed.length) lines.push(`Could not remove: ${failed.join(", ")}`);
        await interaction.editReply(
          lines.length ? `<@${target.id}> — ${lines.join("\n")}` : `<@${target.id}> has no Pod Representative role to remove.`
        );
      }
    } catch (err) {
      await interaction.editReply((err as Error).message);
    }
  },
};

/** /rep list body: project names (not keys), kept under Discord's 2000-char message limit. */
export function formatRepList(
  reps: { memberId: string; project: string; module: number; pod: number }[]
): string {
  if (reps.length === 0) return "No Pod Representatives.";
  const nameOf = (key: string) => org.projects.find((p) => p.key.toLowerCase() === key)?.name ?? key;
  const lines = reps.map((r) => `- <@${r.memberId}> — ${nameOf(r.project)} M${r.module} P${r.pod}`);
  const LIMIT = 1900; // headroom under 2000 for the "…and N more" line
  const out: string[] = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > LIMIT) break;
    out.push(line);
    len += line.length + 1;
  }
  const rest = lines.length - out.length;
  return rest > 0 ? `${out.join("\n")}\n…and ${rest} more` : out.join("\n");
}
