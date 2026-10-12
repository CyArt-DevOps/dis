import { EmbedBuilder } from "discord.js";
import { countAbsences } from "./attendanceStats.js";
import { attendanceReportsChannel } from "./leave.js";
import { logger } from "../core/logger.js";
// Configurable thresholds for unexcused absences.
export const ESCALATIONS = [
    { count: 3, target: "teamlead", title: "Attendance warning: Team Lead notified", color: 0xfaa61a },
    { count: 5, target: "hr", title: "Attendance escalation: HR notified", color: 0xe67e22 },
    { count: 7, target: "manager", title: "Attendance escalation: Manager notified", color: 0xe74c3c },
    { count: 10, target: "flag", title: "Disciplinary review required", color: 0x992d22 },
];
function roleMention(guild, name) {
    const role = guild.roles.cache.find((r) => r.name === name);
    return role ? `<@&${role.id}>` : `**${name}**`;
}
function targetMention(guild, target, projectName) {
    switch (target) {
        case "teamlead":
            return projectName ? roleMention(guild, `${projectName} Team Lead`) : roleMention(guild, "Team Lead");
        case "hr":
            return roleMention(guild, "HR");
        case "manager":
            return roleMention(guild, "Manager");
        case "flag":
            return [roleMention(guild, "Founder"), roleMention(guild, "Manager"), roleMention(guild, "HR")].join(" ");
    }
}
/** After a meeting, check each absentee's running total and fire escalations. */
export async function runEscalations(guild, absentees) {
    const ch = attendanceReportsChannel(guild);
    for (const m of absentees) {
        const total = await countAbsences(m.userId, guild.id);
        const rule = ESCALATIONS.find((e) => e.count === total);
        if (!rule)
            continue;
        const embed = new EmbedBuilder()
            .setTitle(rule.title)
            .setColor(rule.color)
            .setDescription(`<@${m.userId}> (${m.fullName ?? "?"}) has **${total}** unexcused absences.`)
            .addFields({ name: "Batch", value: m.batch ?? "?", inline: true }, { name: "Project", value: m.project ?? "?", inline: true }, { name: "Module / Pod", value: `${m.module ?? "?"} / ${m.pod ?? "?"}`, inline: true })
            .setTimestamp(new Date());
        const mention = targetMention(guild, rule.target, m.project);
        if (ch) {
            await ch.send({ content: mention, embeds: [embed] }).catch((err) => logger.warn({ err, user: m.userId }, "Escalation post failed"));
        }
        logger.info({ user: m.userId, total, target: rule.target }, "Attendance escalation fired");
    }
}
//# sourceMappingURL=escalation.js.map