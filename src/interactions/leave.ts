import { EmbedBuilder, MessageFlags, type Interaction } from "discord.js";
import type { InteractionHandler } from "../core/registry.js";
import {
  LEAVE_IDS,
  LEAVE_TYPES,
  createLeaveRequest,
  decideLeave,
  examApprovalModal,
  leaveApprovalsChannel,
  leaveModal,
  leaveTypeSelect,
  parseExamDates,
  validateLeave,
  type LeaveType,
} from "../services/leave.js";
import { prisma } from "../core/db.js";
import { findProject, org } from "../config/loader.js";
import { roleNames } from "../lib/names.js";
import { deriveMembership } from "../lib/membership.js";
import { ChannelType, type Guild, type TextChannel } from "discord.js";
import { isStaff } from "../lib/rbac.js";
import { logEmbed, postLog } from "../lib/log.js";
import { formatDuration, formatInTz, parseDateTime } from "../lib/time.js";
import { logger } from "../core/logger.js";
import { dmPaused, notifyMember } from "../services/notify.js";

function cid(i: Interaction): string | undefined {
  if (i.isButton() || i.isStringSelectMenu() || i.isModalSubmit()) return i.customId;
  return undefined;
}

/**
 * Notify the intern's project Team Lead(s) that their leave is approved so they
 * can arrange handovers. DMs each Team Lead if possible; posts a fallback in the
 * project's Team Lead chat channel too.
 */
async function notifyProjectTeamLead(
  guild: Guild,
  internUserId: string,
  approvedDays: string[] | undefined,
  startAt: Date,
  endAt: Date,
  typeLabel: string
): Promise<void> {
  // Route by the intern's CURRENT Discord roles — the authoritative source when
  // a Manager changes someone's project by editing roles (the stored DB profile
  // can be stale, e.g. a wrong project picked at onboarding then corrected).
  // Fall back to the DB profile only if no project role is present.
  const gm = await guild.members.fetch(internUserId).catch(() => null);
  let proj = gm ? deriveMembership(gm).project : undefined;
  if (!proj) {
    const member = await prisma.member.findUnique({ where: { id: internUserId } });
    if (member?.project)
      proj = org.projects.find((p) => p.name === member.project) ?? findProject(member.project);
  }
  if (!proj) return;

  const tlRoleName = roleNames.projectTeamLead(proj);
  const tlRole = guild.roles.cache.find((r) => r.name === tlRoleName);
  if (!tlRole) return;

  const internMention = `<@${internUserId}>`;
  const daysStr = approvedDays && approvedDays.length
    ? `**Approved days:** ${approvedDays.join(", ")}`
    : `**From** ${formatInTz(startAt)}\n**To** ${formatInTz(endAt)}`;

  const embed = new EmbedBuilder()
    .setTitle(`Team member on leave: ${typeLabel}`)
    .setColor(0x5865f2)
    .setDescription(
      `${internMention} from your project (**${proj.name}**) has an approved leave.\n\n` +
        `${daysStr}\n\n` +
        `Please coordinate a handover for any deadlines or ongoing work on the covered days.`
    )
    .setTimestamp(new Date());

  // DM each Team Lead (best-effort).
  const dmFailures: string[] = [];
  // Skip DMs while Discord has them quarantined; the Team Lead chat post below covers it.
  for (const tl of tlRole.members.values()) {
    if (dmPaused()) {
      dmFailures.push(tl.id);
      continue;
    }
    await tl.send({ embeds: [embed] }).catch(() => dmFailures.push(tl.id));
  }

  // Fallback: post in the project's Team Lead chat channel so it's not missed
  // even if a lead has DMs off.
  const chatName = `lead-${proj.key}-team-lead-chat`;
  const chat = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === chatName
  ) as TextChannel | undefined;
  if (chat) {
    await chat.send({ content: `<@&${tlRole.id}>`, embeds: [embed] }).catch(() => {});
  }

  if (dmFailures.length > 0) {
    logger.debug({ project: proj.key, dmFailures }, "Some Team Lead DMs not delivered");
  }
}

export async function finalizeDecision(
  i: Interaction,
  staff: import("discord.js").GuildMember,
  id: number,
  approve: boolean,
  approvedDays?: string[]
): Promise<void> {
  // Acknowledge immediately — decideLeave + postLog + DMs below can exceed the
  // 3s interaction window. Button paths defer the message update (edited in
  // place at the end); modal paths defer an ephemeral reply.
  if (i.isButton() && !i.deferred && !i.replied) {
    await i.deferUpdate().catch(() => {});
  } else if (i.isModalSubmit() && !i.deferred && !i.replied) {
    await i.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const result = await decideLeave(id, approve, staff.id, approvedDays);
  if (!result) {
    if (i.isRepliable()) {
      const notice = { content: "Already decided or not found." } as const;
      if (i.deferred || i.replied) await i.followUp({ ...notice, flags: MessageFlags.Ephemeral }).catch(() => {});
      else await i.reply({ ...notice, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  await postLog(
    staff.guild,
    "audit",
    logEmbed(`Leave ${result.status}`, approve ? 0x57f287 : 0xed4245)
      .setDescription(`Request #${id} for <@${result.userId}>`)
      .addFields({ name: "By", value: `<@${staff.id}>` })
  );

  // Decision record for HR in #leave-approvals. The private ticket is deleted
  // moments from now, so this line has to stand on its own: who, what, by whom,
  // for how long, and when it was decided.
  const approvals = leaveApprovalsChannel(staff.guild);
  if (approvals) {
    const typeLabel = LEAVE_TYPES[result.type]?.label ?? result.type;
    const requester =
      staff.guild.members.cache.get(result.userId)?.displayName ??
      (await staff.guild.members.fetch(result.userId).catch(() => null))?.displayName ??
      `Member ${result.userId}`;
    const span =
      approvedDays && approvedDays.length
        ? `${approvedDays.length} exam day(s): ${approvedDays.join(", ")}`
        : formatDuration(result.startAt, result.endAt);
    const verb = approve ? "Approved" : "Rejected";
    const preposition = approve ? "to" : "for";
    await approvals
      .send(
        `Leave ${verb} ${preposition} ${requester} by ${staff.displayName} for [${typeLabel} Request #${id}] for ${span} on ${formatInTz(new Date())}`
      )
      .catch(() => {});
  }

  // Ack in-channel (button or modal path).
  const summary = approvedDays && approvedDays.length
    ? `Leave #${id} **approved** by <@${staff.id}> for ${approvedDays.length} exam day(s): ${approvedDays.join(", ")}`
    : `Leave #${id} **${result.status}** by <@${staff.id}>.`;
  if (i.isButton()) {
    // deferUpdate above → editReply edits the original approval message, stripping its buttons.
    await i.editReply({ content: summary, components: [] }).catch(() => {});
  } else if (i.isModalSubmit()) {
    await i.editReply({ content: summary }).catch(() => {});
  } else if (i.isChatInputCommand()) {
    // `/leave approve` path: it defers first, so edit that deferred reply.
    if (i.deferred || i.replied) await i.editReply({ content: summary }).catch(() => {});
    else await i.reply({ content: summary, flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  // Close the private leave channel shortly after a decision.
  if (result.channelId) {
    const ch = staff.guild.channels.cache.get(result.channelId);
    if (ch) {
      await (ch as import("discord.js").TextChannel)
        .send(`This leave request is **${result.status}**. This channel will be deleted in 15 seconds.`)
        .catch(() => {});
      setTimeout(() => {
        ch.delete("Leave request resolved").catch(() => {});
      }, 15_000);
    }
  }

  // Personal DM to the requester.
  const user = await staff.client.users.fetch(result.userId).catch(() => null);
  if (user) {
    const label = LEAVE_TYPES[result.type]?.label ?? result.type;
    const dm = new EmbedBuilder()
      .setTitle(`Leave Request #${id} — ${result.status.toUpperCase()}`)
      .setColor(approve ? 0x57f287 : 0xed4245)
      .addFields(
        { name: "Type", value: label, inline: true },
        { name: "From", value: formatInTz(result.startAt), inline: true },
        { name: "To", value: formatInTz(result.endAt), inline: true },
        { name: "Decided by", value: `${staff.displayName}` }
      );
    if (approve) {
      if (approvedDays && approvedDays.length) {
        dm.addFields({ name: "Approved exam days", value: approvedDays.join(", ") });
        dm.setDescription(
          "Your exam leave has been approved. You are automatically excused from meeting attendance on the approved exam days only."
        );
      } else {
        dm.setDescription(
          "Your leave has been approved. You are automatically excused from meeting attendance for the covered days."
        );
      }
    } else {
      dm.setDescription("Your leave request was not approved. Please contact HR if you have questions.");
    }

    // DM, or a private thread in their team channel if DMs can't be delivered.
    const delivery = await notifyMember(staff.guild, result.userId, { embeds: [dm], threadName: `Leave #${id} ${result.status}` });
    if (delivery.via === "none") logger.warn({ user: result.userId, leave: id }, "Leave decision could not be delivered");
  }

  // On approval, notify the intern's project Team Lead so they can arrange
  // handovers for any deadlines on the covered days.
  if (approve) {
    await notifyProjectTeamLead(
      staff.guild,
      result.userId,
      approvedDays,
      result.startAt,
      result.endAt,
      LEAVE_TYPES[result.type]?.label ?? result.type
    ).catch((err) => logger.warn({ err, leave: id }, "Team Lead handover notification failed"));
  }
}

export const leaveApproveHandler: InteractionHandler = {
  id: "leave:approve",
  matches: (i) => i.isButton() && (cid(i)?.startsWith(LEAVE_IDS.approve + ":") ?? false),
  async handle(i) {
    if (!i.isButton() || !i.inCachedGuild()) return;
    // Exam leave answers with showModal (no deferral possible), so this path
    // must stay lean: use the member from the interaction, not a REST fetch.
    const staff = i.member;
    if (!isStaff(staff)) {
      await i.reply({ content: "Only HR/Manager/Founder can decide leave.", flags: MessageFlags.Ephemeral });
      return;
    }
    const id = Number(cid(i)!.split(":")[2]);
    const row = await prisma.leaveRequest.findUnique({ where: { id } });
    if (!row || row.status !== "pending") {
      await i.reply({ content: "Already decided or not found.", flags: MessageFlags.Ephemeral });
      return;
    }
    // For exam leave, HR must pick the specific exam days from the timetable.
    if (row.type === "exam") {
      await i.showModal(examApprovalModal(id));
      return;
    }
    await finalizeDecision(i, staff, id, true);
  },
};

export const leaveRejectHandler: InteractionHandler = {
  id: "leave:reject",
  matches: (i) => i.isButton() && (cid(i)?.startsWith(LEAVE_IDS.reject + ":") ?? false),
  async handle(i) {
    if (!i.isButton() || !i.inCachedGuild()) return;
    const staff = await i.guild.members.fetch(i.user.id);
    if (!isStaff(staff)) {
      await i.reply({ content: "Only HR/Manager/Founder can decide leave.", flags: MessageFlags.Ephemeral });
      return;
    }
    const id = Number(cid(i)!.split(":")[2]);
    await finalizeDecision(i, staff, id, false);
  },
};

export const leaveExamApproveHandler: InteractionHandler = {
  id: "leave:approve:exam",
  matches: (i) =>
    i.isModalSubmit() && (cid(i)?.startsWith(LEAVE_IDS.examApproveModal + ":") ?? false),
  async handle(i) {
    if (!i.isModalSubmit() || !i.inCachedGuild()) return;
    const staff = await i.guild.members.fetch(i.user.id);
    if (!isStaff(staff)) {
      await i.reply({ content: "Only HR/Manager/Founder can decide leave.", flags: MessageFlags.Ephemeral });
      return;
    }
    const id = Number(cid(i)!.split(":").pop());
    const raw = i.fields.getTextInputValue("dates");
    const days = parseExamDates(raw);
    if (!days) {
      await i.reply({
        content: "❌ Couldn't parse those dates. Use `DD/MM/YYYY`, comma-separated (e.g. `15/07/2026, 18/07/2026`).",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Sanity-check dates fall within the requested range.
    const row = await prisma.leaveRequest.findUnique({ where: { id } });
    if (!row || row.status !== "pending") {
      await i.reply({ content: "Already decided or not found.", flags: MessageFlags.Ephemeral });
      return;
    }
    const startKey = row.startAt.toISOString().slice(0, 10);
    const endKey = row.endAt.toISOString().slice(0, 10);
    const outOfRange = days.filter((d) => d < startKey || d > endKey);
    if (outOfRange.length > 0) {
      await i.reply({
        content: `❌ These dates are outside the requested period (${startKey} → ${endKey}): ${outOfRange.join(", ")}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await finalizeDecision(i, staff, id, true, days);
  },
};

export const leaveStartHandler: InteractionHandler = {
  id: "leave:start",
  matches: (i) => i.isButton() && cid(i) === LEAVE_IDS.start,
  async handle(i) {
    if (!i.isButton()) return;
    await i.reply({
      content: "Select the type of leave:",
      components: [leaveTypeSelect()],
      flags: MessageFlags.Ephemeral,
    });
  },
};

export const leaveTypeHandler: InteractionHandler = {
  id: "leave:type",
  matches: (i) => i.isStringSelectMenu() && cid(i) === LEAVE_IDS.typeSelect,
  async handle(i) {
    if (!i.isStringSelectMenu()) return;
    const type = i.values[0] as LeaveType;
    if (!LEAVE_TYPES[type]) {
      await i.reply({ content: "Unknown leave type.", flags: MessageFlags.Ephemeral });
      return;
    }
    await i.showModal(leaveModal(type));
  },
};

export const leaveModalHandler: InteractionHandler = {
  id: "leave:modal",
  // createLeaveRequest creates a private channel + DB rows — well over 3s under
  // load. Dispatcher defers an ephemeral reply first; we editReply below.
  ack: "reply",
  matches: (i) => i.isModalSubmit() && (cid(i)?.startsWith(LEAVE_IDS.modal + ":") ?? false),
  async handle(i) {
    if (!i.isModalSubmit() || !i.inCachedGuild()) return;
    const type = cid(i)!.split(":")[2] as LeaveType;
    const startAt = parseDateTime(i.fields.getTextInputValue("start_date"), "12:00 AM");
    const endAt = parseDateTime(i.fields.getTextInputValue("end_date"), "11:59 PM");
    const reason = i.fields.getTextInputValue("reason");
    if (!startAt || !endAt) {
      await i.editReply({ content: "Invalid date. Use `DD/MM/YYYY`." });
      return;
    }
    if (endAt.getTime() < startAt.getTime()) {
      await i.editReply({ content: "End date must be on/after start date." });
      return;
    }
    const check = validateLeave(type, startAt, endAt);
    if (!check.ok) {
      await i.editReply({ content: `❌ ${check.reason}` });
      return;
    }
    const member = await i.guild.members.fetch(i.user.id);
    const { id, channelId } = await createLeaveRequest(member, type, startAt, endAt, reason);
    const where = channelId ? `A private channel with HR has been created: <#${channelId}>.` : "HR will review it.";
    await i.editReply({
      content: `${LEAVE_TYPES[type].label} request **#${id}** submitted for ${formatInTz(startAt)} → ${formatInTz(endAt)}. ${where}`,
    });
  },
};

export const leaveHandlers: InteractionHandler[] = [
  leaveApproveHandler,
  leaveRejectHandler,
  leaveExamApproveHandler,
  leaveStartHandler,
  leaveTypeHandler,
  leaveModalHandler,
];
