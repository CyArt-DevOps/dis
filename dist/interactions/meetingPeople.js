import { getPendingPeopleMeeting, deletePendingPeopleMeeting } from "../services/pendingPeopleMeetings.js";
import { audienceLabel, scheduleMeeting } from "../services/meetingScheduler.js";
import { discordTimestamp, formatInTz, tzName } from "../lib/time.js";
export const MEETING_PEOPLE_SELECT_ID = "meeting:people-select";
export const meetingPeopleSelectHandler = {
    id: MEETING_PEOPLE_SELECT_ID,
    matches(interaction) {
        return interaction.isUserSelectMenu() && interaction.customId === MEETING_PEOPLE_SELECT_ID;
    },
    async handle(interaction) {
        if (!interaction.isUserSelectMenu())
            return;
        const pending = getPendingPeopleMeeting(interaction.user.id);
        if (!pending) {
            await interaction.update({
                content: "This selection expired. Run `/meeting schedule` again.",
                components: [],
            });
            return;
        }
        deletePendingPeopleMeeting(interaction.user.id);
        const memberIds = Array.from(interaction.members?.values() ?? [])
            .filter((m) => !m.user.bot)
            .map((m) => m.user.id);
        if (memberIds.length === 0) {
            await interaction.update({
                content: "No valid (non-bot) members were selected. Run `/meeting schedule` again.",
                components: [],
            });
            return;
        }
        const args = { ...pending, audienceMemberIds: memberIds.join(",") };
        const m = await scheduleMeeting(args);
        await interaction.update({
            content: `Scheduled **#${m.id} — ${m.title}**\n` +
                `When: ${formatInTz(args.startAt)} (${tzName()}) · ${discordTimestamp(args.startAt, "R")}\n` +
                `Audience: ${audienceLabel(args)} (${memberIds.length} members)\n` +
                `Reminders: 24h / 1h / 15m / 5m / start. Attendance window: ${args.attendanceWindowMin}m.`,
            components: [],
        });
    },
};
//# sourceMappingURL=meetingPeople.js.map