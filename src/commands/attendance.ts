import { EmbedBuilder, SlashCommandBuilder, MessageFlags } from "discord.js";
import type { SlashCommand } from "../core/registry.js";
import { isStaff } from "../lib/rbac.js";
import { fmtDuration, getSummary } from "../services/attendance.js";
import {
  computeAttendance,
  computeByMember,
  computeRecords,
  type AttendanceFilter,
} from "../services/attendanceStats.js";
import { activeProjects, findProject, org } from "../config/loader.js";
import { parseDateTime, formatInTz } from "../lib/time.js";
import { csvBuffer } from "../lib/csv.js";
import { excelBuffer, pdfBuffer, type Cell } from "../lib/exporters.js";
import { AttachmentBuilder } from "discord.js";

const projectChoices = () =>
  activeProjects().slice(0, 25).map((p) => ({ name: p.name, value: p.key }));
const batchChoices = () => org.batches.slice(0, 25).map((b) => ({ name: b, value: b }));

function buildFilter(
  interaction: import("discord.js").ChatInputCommandInteraction<"cached">
): AttendanceFilter {
  const projectKey = interaction.options.getString("project") ?? undefined;
  const fromStr = interaction.options.getString("from");
  const toStr = interaction.options.getString("to");
  return {
    guildId: interaction.guildId,
    userId: interaction.options.getUser("member")?.id,
    batch: interaction.options.getString("batch") ?? undefined,
    project: projectKey ? findProject(projectKey)?.name : undefined,
    module: interaction.options.getInteger("module") ?? undefined,
    pod: interaction.options.getInteger("pod") ?? undefined,
    from: fromStr ? parseDateTime(fromStr, "12:00 AM") ?? undefined : undefined,
    to: toStr ? parseDateTime(toStr, "11:59 PM") ?? undefined : undefined,
    meetingId: interaction.options.getInteger("meeting") ?? undefined,
  };
}

export const attendance: SlashCommand = {
  get data() {
    return new SlashCommandBuilder()
    .setName("attendance")
    .setDescription("View voice & meeting attendance")
    .setDMPermission(false)
    .addSubcommand((sc) =>
      sc.setName("me").setDescription("Your own voice attendance summary")
    )
    .addSubcommand((sc) =>
      sc
        .setName("user")
        .setDescription("Another member's voice attendance (staff only)")
        .addUserOption((o) =>
          o.setName("member").setDescription("Member").setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("report")
        .setDescription("Meeting attendance report (staff)")
        .addUserOption((o) => o.setName("member").setDescription("Filter by member"))
        .addStringOption((o) =>
          o.setName("batch").setDescription("Filter by batch").addChoices(...batchChoices())
        )
        .addStringOption((o) =>
          o.setName("project").setDescription("Filter by project").addChoices(...projectChoices())
        )
        .addIntegerOption((o) => o.setName("module").setDescription("Filter by module").setMinValue(1))
        .addIntegerOption((o) => o.setName("pod").setDescription("Filter by pod").setMinValue(1))
        .addStringOption((o) => o.setName("from").setDescription("From date DD/MM/YYYY"))
        .addStringOption((o) => o.setName("to").setDescription("To date DD/MM/YYYY"))
        .addIntegerOption((o) => o.setName("meeting").setDescription("Specific meeting ID"))
    )
    .addSubcommand((sc) =>
      sc
        .setName("export")
        .setDescription("Export attendance as CSV/Excel/PDF (staff)")
        .addStringOption((o) =>
          o
            .setName("format")
            .setDescription("File format (default CSV)")
            .addChoices(
              { name: "CSV", value: "csv" },
              { name: "Excel", value: "excel" },
              { name: "PDF", value: "pdf" }
            )
        )
        .addBooleanOption((o) =>
          o.setName("detailed").setDescription("Per-record rows instead of per-member totals")
        )
        .addUserOption((o) => o.setName("member").setDescription("Filter by member"))
        .addStringOption((o) =>
          o.setName("batch").setDescription("Filter by batch").addChoices(...batchChoices())
        )
        .addStringOption((o) =>
          o.setName("project").setDescription("Filter by project").addChoices(...projectChoices())
        )
        .addIntegerOption((o) => o.setName("module").setDescription("Filter by module").setMinValue(1))
        .addIntegerOption((o) => o.setName("pod").setDescription("Filter by pod").setMinValue(1))
        .addStringOption((o) => o.setName("from").setDescription("From date DD/MM/YYYY"))
        .addStringOption((o) => o.setName("to").setDescription("To date DD/MM/YYYY"))
        .addIntegerOption((o) => o.setName("meeting").setDescription("Specific meeting ID"))
    )
    .addSubcommand((sc) =>
      sc
        .setName("leaderboard")
        .setDescription("Attendance leaderboard (staff)")
        .addStringOption((o) =>
          o.setName("project").setDescription("Filter by project").addChoices(...projectChoices())
        )
        .addStringOption((o) =>
          o.setName("batch").setDescription("Filter by batch").addChoices(...batchChoices())
        )
        .addIntegerOption((o) => o.setName("module").setDescription("Filter by module").setMinValue(1))
        .addIntegerOption((o) => o.setName("pod").setDescription("Filter by pod").setMinValue(1))
        .addIntegerOption((o) =>
          o.setName("min_meetings").setDescription("Only members with at least N meetings (default 1)").setMinValue(1)
        )
    );
  },
  async execute(interaction) {
    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral });
      return;
    }
    const sub = interaction.options.getSubcommand();
    // Defer immediately: DB queries + member fetches can exceed the 3s
    // interaction token window (DiscordAPIError 10062 "Unknown interaction").
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (sub === "export") {
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      if (!isStaff(actor)) {
        await interaction.editReply({ content: "Staff only." });
        return;
      }
      const filter = buildFilter(interaction);
      const detailed = interaction.options.getBoolean("detailed") ?? false;
      const format = interaction.options.getString("format") ?? "csv";

      let headers: string[];
      let rows: Cell[][];
      let base: string;
      if (detailed) {
        const recs = await computeRecords(filter);
        headers = ["MeetingID", "Meeting", "Member", "FullName", "Batch", "Project", "Module", "Pod", "Status", "MinutesLate", "ScheduledStart", "JoinTime"];
        rows = recs.map((r) => [
          r.meeting.id,
          r.meeting.title,
          r.userId,
          r.fullName ?? "",
          r.batch ?? "",
          r.project ?? "",
          r.module ?? "",
          r.pod ?? "",
          r.status,
          r.minutesLate,
          formatInTz(r.scheduledStart),
          r.actualJoinAt ? formatInTz(r.actualJoinAt) : "",
        ]);
        base = "attendance-records";
      } else {
        const members = (await computeByMember(filter)).sort((a, b) => b.pct - a.pct);
        headers = ["Member", "FullName", "Project", "Module", "Pod", "Present", "Late", "Absent", "Excused", "Meetings", "AttendancePct"];
        rows = members.map((m) => [
          m.userId, m.fullName, m.project, m.module ?? "", m.pod ?? "",
          m.present, m.late, m.absent, m.excused, m.total, m.pct,
        ]);
        base = "attendance-summary";
      }

      let buf: Buffer;
      let name: string;
      if (format === "excel") {
        buf = await excelBuffer("Attendance", headers, rows);
        name = `${base}.xlsx`;
      } else if (format === "pdf") {
        buf = await pdfBuffer("Attendance Report", headers, rows);
        name = `${base}.pdf`;
      } else {
        buf = csvBuffer(headers, rows);
        name = `${base}.csv`;
      }
      await interaction.editReply({
        content: `Attendance export (${format.toUpperCase()}):`,
        files: [new AttachmentBuilder(buf, { name })],
      });
      return;
    }

    if (sub === "leaderboard") {
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      if (!isStaff(actor)) {
        await interaction.editReply({ content: "Staff only." });
        return;
      }
      const filter = buildFilter(interaction);
      const minMeetings = interaction.options.getInteger("min_meetings") ?? 1;
      const all = (await computeByMember(filter)).filter((m) => m.total >= minMeetings);
      if (all.length === 0) {
        await interaction.editReply({ content: "No attendance data for that scope." });
        return;
      }
      all.sort((a, b) => b.pct - a.pct || b.total - a.total);
      const top = all.slice(0, 10);
      const bottom = all.length > 10 ? all.slice(-5).reverse() : [];
      const line = (m: (typeof all)[number], i: number) =>
        `**${i + 1}.** ${m.fullName} — ${m.pct}% (${m.present + m.late}/${m.total})`;

      const embed = new EmbedBuilder()
        .setTitle("🏆 Attendance Leaderboard")
        .setColor(0x57f287)
        .addFields({
          name: "Top",
          value: top.map((m, i) => line(m, i)).join("\n").slice(0, 1024),
        });
      if (bottom.length) {
        embed.addFields({
          name: "Needs attention (lowest)",
          value: bottom.map((m, i) => `${m.fullName} — ${m.pct}% (${m.absent} absent)`).join("\n").slice(0, 1024),
        });
      }
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === "report") {
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      if (!isStaff(actor)) {
        await interaction.editReply({ content: "Staff only." });
        return;
      }
      const projectKey = interaction.options.getString("project") ?? undefined;
      const projectName = projectKey ? findProject(projectKey)?.name : undefined;
      const fromStr = interaction.options.getString("from");
      const toStr = interaction.options.getString("to");
      const from = fromStr ? parseDateTime(fromStr, "12:00 AM") ?? undefined : undefined;
      const to = toStr ? parseDateTime(toStr, "11:59 PM") ?? undefined : undefined;

      const filter: AttendanceFilter = {
        guildId: interaction.guildId,
        userId: interaction.options.getUser("member")?.id,
        batch: interaction.options.getString("batch") ?? undefined,
        project: projectName,
        module: interaction.options.getInteger("module") ?? undefined,
        pod: interaction.options.getInteger("pod") ?? undefined,
        from,
        to,
        meetingId: interaction.options.getInteger("meeting") ?? undefined,
      };
      const s = await computeAttendance(filter);

      const scopeBits: string[] = [];
      const mem = interaction.options.getUser("member");
      if (mem) scopeBits.push(`<@${mem.id}>`);
      if (filter.batch) scopeBits.push(filter.batch);
      if (projectName) scopeBits.push(projectName);
      if (filter.module) scopeBits.push(`M${filter.module}`);
      if (filter.pod) scopeBits.push(`P${filter.pod}`);
      if (filter.meetingId) scopeBits.push(`Meeting #${filter.meetingId}`);

      const embed = new EmbedBuilder()
        .setTitle("Meeting Attendance Report")
        .setColor(s.attendancePct >= 80 ? 0x57f287 : s.attendancePct >= 50 ? 0xfaa61a : 0xed4245)
        .setDescription(scopeBits.length ? `Scope: ${scopeBits.join(" · ")}` : "Scope: all")
        .addFields(
          { name: "Attendance %", value: `${s.attendancePct}%`, inline: true },
          { name: "Meetings", value: String(s.totalMeetings), inline: true },
          { name: "Records", value: String(s.records), inline: true },
          { name: "✅ Present", value: String(s.present), inline: true },
          { name: "🟡 Late", value: String(s.late), inline: true },
          { name: "❌ Absent", value: String(s.absent), inline: true },
          { name: "🟣 Excused", value: String(s.excused), inline: true },
          { name: "Avg delay", value: `${s.avgDelayMin} min`, inline: true }
        )
        .setTimestamp(new Date());
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    let targetId = interaction.user.id;
    if (sub === "user") {
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      if (!isStaff(actor)) {
        await interaction.editReply({ content: "Staff only." });
        return;
      }
      targetId = interaction.options.getUser("member", true).id;
    }

    const s = await getSummary(interaction.guildId!, targetId);
    const embed = new EmbedBuilder()
      .setTitle("Attendance")
      .setDescription(`<@${targetId}>${s.live ? " · 🟢 in voice now" : ""}`)
      .setColor(0x5865f2)
      .addFields(
        { name: "Today", value: fmtDuration(s.todaySeconds), inline: true },
        { name: "This week", value: fmtDuration(s.weekSeconds), inline: true },
        { name: "This month", value: fmtDuration(s.monthSeconds), inline: true }
      );
    await interaction.editReply({ embeds: [embed] });
  },
};
