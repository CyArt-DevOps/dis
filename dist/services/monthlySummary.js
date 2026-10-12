import { EmbedBuilder } from "discord.js";
import { logger } from "../core/logger.js";
import { activeProjects } from "../config/loader.js";
import { roleNames } from "../lib/names.js";
import { computeAttendance } from "./attendanceStats.js";
import { attendanceReportsChannel } from "./leave.js";
import { previousMonthRange, nowParts } from "../lib/time.js";
import { readState, updateState } from "../core/state.js";
let client = null;
let timer = null;
/** Post a per-project attendance summary for the previous month. */
export async function runMonthlySummary(guild) {
    const { start, end, label } = previousMonthRange();
    const ch = attendanceReportsChannel(guild);
    if (!ch) {
        logger.warn("No #attendance-reports — skipping monthly summary");
        return;
    }
    const header = new EmbedBuilder()
        .setTitle(`Monthly Attendance Summary: ${label}`)
        .setColor(0x5865f2)
        .setTimestamp(new Date());
    // Let send failures propagate: the hourly tick must NOT mark the month as
    // posted when nothing was delivered (e.g. a transient API outage), so it
    // retries on the next hourly check instead of dropping the summary.
    await ch.send({ embeds: [header] });
    for (const p of activeProjects()) {
        const s = await computeAttendance({
            guildId: guild.id,
            project: p.name,
            from: start,
            to: end,
        });
        if (s.records === 0)
            continue;
        const role = guild.roles.cache.find((r) => r.name === roleNames.projectTeamLead(p));
        const embed = new EmbedBuilder()
            .setTitle(p.name)
            .setColor(s.attendancePct >= 80 ? 0x57f287 : s.attendancePct >= 50 ? 0xfaa61a : 0xed4245)
            .addFields({ name: "Attendance %", value: `${s.attendancePct}%`, inline: true }, { name: "Meetings", value: String(s.totalMeetings), inline: true }, { name: "Present/Late/Absent/Excused", value: `${s.present}/${s.late}/${s.absent}/${s.excused}` });
        await ch.send({ content: role ? `<@&${role.id}>` : undefined, embeds: [embed] });
    }
    logger.info({ month: label }, "Monthly summary posted");
}
/** Hourly check: on the 1st at >= 9:00 (TZ), post once per month. */
async function tick() {
    if (!client)
        return;
    const { year, month, day, hour } = nowParts();
    if (day !== 1 || hour < 9)
        return;
    const key = `${year}-${String(month).padStart(2, "0")}`;
    if (readState().lastMonthlySummary === key)
        return;
    let allPosted = true;
    for (const guild of client.guilds.cache.values()) {
        await runMonthlySummary(guild).catch((err) => {
            allPosted = false;
            logger.error({ err, guild: guild.id }, "Monthly summary failed — will retry next hour");
        });
    }
    // Only mark the month done when every guild posted; otherwise the next
    // hourly tick retries (posts are idempotent enough — worst case a partial
    // duplicate for a guild that succeeded, never a silently lost month).
    if (allPosted)
        updateState("lastMonthlySummary", key);
}
export function startMonthlySummary(c) {
    client = c;
    if (timer)
        clearInterval(timer);
    timer = setInterval(() => void tick().catch((err) => logger.error({ err }, "monthly tick")), 3600_000);
    logger.info("Monthly summary scheduler started (hourly check)");
}
export function stopMonthlySummary() {
    if (timer)
        clearInterval(timer);
    timer = null;
}
//# sourceMappingURL=monthlySummary.js.map