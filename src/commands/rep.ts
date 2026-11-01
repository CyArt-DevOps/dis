import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  SlashCommandBuilder,
  MessageFlags,
  type GuildMember,
} from "discord.js";
import type { SlashCommand } from "../core/registry.js";
import { canManageLeadership, isProjectTeamLead } from "../lib/rbac.js";
import { activeProjects, findProject, org } from "../config/loader.js";
import { roleNames } from "../lib/names.js";
import { assignPodRep, listPodReps, podRepHolders, removePodRep } from "../services/leadership.js";
import { leadershipFromRoleNames, repChangedPayload } from "../services/integrationPayloads.js";
import { enqueueEvent } from "../services/emsOutbox.js";

// Pod Representatives (Phase 6): "<Project> M<m> P<n> Representative". EMS grants the pod powers.
// Sub-project C: staff or the project's Team Lead may assign / remove (one rep per pod: an occupied pod asks
// "Replace @old?" with Replace / Cancel buttons); removal needs a reason; every change is reported to EMS.
const projectChoices = () =>
  activeProjects()
    .filter((p) => p.modules > 0 && p.podsPerModule > 0)
    .slice(0, 25)
    .map((p) => ({ name: p.name, value: p.key }));

export const REP_IDS = { replace: "rep:replace", cancel: "rep:cancel" } as const;
const REPLACE_WAIT_MS = 60_000;

const leadershipOf = (m: GuildMember) => leadershipFromRoleNames([...m.roles.cache.values()].map((r) => r.name), org.projects);

function replaceButtons() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(REP_IDS.replace).setLabel("Replace").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(REP_IDS.cancel).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );
}

export const rep: SlashCommand = {
  get data() {
    return new SlashCommandBuilder()
      .setName("rep")
      .setDescription("Manage Pod Representatives")
      // Team Leads hold ManageMessages (not ManageRoles); execute() decides who may act on which project.
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
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
            o.setName("reason").setDescription("Why the rep is removed").setRequired(true).setMinLength(3).setMaxLength(500)
          )
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
    const projectKey = interaction.options.getString("project") ?? undefined;
    // Staff anywhere; a Team Lead only for their own project (so never a project-less /rep remove or /rep list).
    if (!canManageLeadership(actor) && !(projectKey && isProjectTeamLead(actor, projectKey))) {
      await interaction.reply({ content: "Not allowed.", flags: MessageFlags.Ephemeral });
      return;
    }
    const sub = interaction.options.getSubcommand();

    if (sub === "list") {
      const reps = listPodReps(interaction.guild, projectKey);
      await interaction.reply({ content: formatRepList(reps), flags: MessageFlags.Ephemeral });
      return;
    }

    // Role edits + audit log can take a while; acknowledge within Discord's 3 s window.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const user = interaction.options.getUser("member", true);
      const target = await interaction.guild.members.fetch(user.id);

      if (sub === "assign") {
        const key = interaction.options.getString("project", true);
        const moduleNum = interaction.options.getInteger("module", true);
        const podNum = interaction.options.getInteger("pod", true);
        // A Team Lead picks from the pod's own members (as EMS does); only staff may pull someone in from outside.
        const project = findProject(key);
        if (!canManageLeadership(actor) && project) {
          const podRole = roleNames.pod(project, moduleNum, podNum);
          if (![...target.roles.cache.values()].some((r) => r.name === podRole)) {
            await interaction.editReply(`<@${target.id}> is not in ${project.name} M${moduleNum} P${podNum}.`);
            return;
          }
        }
        const holders = podRepHolders(interaction.guild, key, moduleNum, podNum, target.id);
        let replace = false;
        if (holders.length) {
          const label = `${findProject(key)?.name ?? key} M${moduleNum} P${podNum}`;
          const msg = await interaction.editReply({
            content: `Replace ${holders.map((h) => `<@${h.id}>`).join(", ")} as ${label} Representative?`,
            components: [replaceButtons()],
          });
          let click;
          try {
            click = await msg.awaitMessageComponent({ filter: (i) => i.user.id === interaction.user.id, time: REPLACE_WAIT_MS });
          } catch {
            await interaction.editReply({ content: "No answer — nothing changed.", components: [] });
            return;
          }
          if (click.customId !== REP_IDS.replace) {
            await click.update({ content: "Cancelled — nothing changed.", components: [] });
            return;
          }
          await click.update({ content: "Replacing…", components: [] });
          replace = true;
        }
        const applied = await assignPodRep({ member: target, projectKey: key, moduleNum, podNum, actor, replace });
        await interaction.editReply({ content: `<@${target.id}> is now a Pod Representative. Roles: ${applied.join(", ")}`, components: [] });
        const base = { discordUserId: target.id, project: key, module: moduleNum, pod: podNum, actorDiscordId: actor.id, leadership: leadershipOf(target) };
        if (!holders.length) await enqueueEvent("rep.changed", repChangedPayload({ ...base, action: "assigned" }));
        for (const h of holders) {
          await enqueueEvent("rep.changed", repChangedPayload({ ...base, action: "replaced", replacedDiscordUserId: h.id, replacedLeadership: leadershipOf(h) }));
        }
        return;
      }

      if (sub === "remove") {
        const reason = interaction.options.getString("reason")?.trim() ?? "";
        if (reason.length < 3) {
          await interaction.editReply("Give a reason (at least 3 characters).");
          return;
        }
        const { removed, failed } = await removePodRep({
          member: target,
          actor,
          projectKey,
          moduleNum: interaction.options.getInteger("module") ?? undefined,
          podNum: interaction.options.getInteger("pod") ?? undefined,
          reason,
        });
        const lines: string[] = [];
        if (removed.length) lines.push(`Removed: ${removed.join(", ")}`);
        if (failed.length) lines.push(`Could not remove: ${failed.join(", ")}`);
        await interaction.editReply(
          lines.length ? `<@${target.id}> — ${lines.join("\n")}` : `<@${target.id}> has no Pod Representative role to remove.`
        );
        const leadership = leadershipOf(target);
        for (const ref of leadershipFromRoleNames(removed, org.projects).podRepOf) {
          await enqueueEvent("rep.changed", repChangedPayload({
            action: "removed", discordUserId: target.id, project: ref.project, module: ref.module, pod: ref.pod, actorDiscordId: actor.id, reason, leadership,
          }));
        }
      }
    } catch (err) {
      await interaction.editReply({ content: (err as Error).message, components: [] });
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
