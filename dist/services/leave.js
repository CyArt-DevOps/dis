import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, ModalBuilder, PermissionFlagsBits, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TextInputBuilder, TextInputStyle, } from "discord.js";
import { prisma } from "../core/db.js";
import { org } from "../config/loader.js";
import { logger } from "../core/logger.js";
import { formatDateInTz, formatDuration, formatInTz, inclusiveDaySpan } from "../lib/time.js";
import { ticketsCategoryWithRoom } from "./ticketCategory.js";
import { HALF_DAY_STARTS, halfDayEnd, halfDayLabel, halfWindowError, halfWindowUtc, leaveCoversAt, leaveLabel } from "../lib/halfDay.js";
export const LEAVE_IDS = {
    approve: "leave:approve", // leave:approve:<id>
    reject: "leave:reject", // leave:reject:<id>
    start: "leave:start", // panel button
    typeSelect: "leave:type", // type select menu
    modal: "leave:modal", // leave:modal:<type>  (half day: leave:modal:half_day:<HHMM>)
    halfStart: "leave:halfstart", // half-day start time select
    examApproveModal: "leave:approve:exam", // leave:approve:exam:<id> — HR picks exam days
};
export const LEAVE_TYPES = {
    casual: { key: "casual", label: "Casual Leave", maxDays: 1, priorDays: 1, doc: "never", docLabel: "" },
    sick: { key: "sick", label: "Sick Leave", maxDays: null, priorDays: 0, doc: "over1", docLabel: "medical certificate" },
    // Exam leave: span the exam PERIOD (max 30 days); HR picks the actual exam days
    // from the uploaded timetable when approving — only those days get excused.
    exam: { key: "exam", label: "University Examination Leave", maxDays: 30, priorDays: 3, doc: "always", docLabel: "exam timetable" },
    // Half day (EMS spec 2026-11-07 §7): one date, a 3 h window inside 11:30–19:00 IST. Not a day off: only the window is excused.
    half_day: { key: "half_day", label: "Half day", maxDays: 1, priorDays: 0, doc: "never", docLabel: "" },
};
export const LEAVE_TYPE_CHOICES = Object.values(LEAVE_TYPES).map((t) => ({
    name: t.label,
    value: t.key,
}));
export function leavePanelEmbed() {
    return new EmbedBuilder()
        .setTitle("Leave Requests")
        .setColor(0x57f287)
        .setDescription("Click **Request Leave** to submit a request. HR will review it. If approved, you are automatically excused from meeting attendance for the covered days.\n\n" +
        "**Casual Leave**: up to 1 day. Request at least 1 day in advance.\n" +
        "**Sick Leave**: 1 day without a document. Longer periods require a medical certificate.\n" +
        "**University Examination Leave**: enter your exam period, request 3 days ahead, and upload your timetable. HR approves the specific exam days from the timetable.\n" +
        "**Half day**: one date and a 3-hour window starting between 11:30 and 16:00. The rest of the day is a normal working day.\n\n" +
        "A private channel with HR is created for your request. If a document is required, upload it there.");
}
export function leavePanelButton() {
    return new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId(LEAVE_IDS.start)
        .setLabel("Request Leave")
        .setEmoji("🌴")
        .setStyle(ButtonStyle.Success));
}
export function leaveTypeSelect() {
    const menu = new StringSelectMenuBuilder()
        .setCustomId(LEAVE_IDS.typeSelect)
        .setPlaceholder("Select a leave type")
        .addOptions(Object.values(LEAVE_TYPES).map((t) => new StringSelectMenuOptionBuilder().setLabel(t.label).setValue(t.key)));
    return new ActionRowBuilder().addComponents(menu);
}
/** Half-day start picker: every option shows its end time, so the intern sees the window before submitting. */
export function halfStartSelect() {
    const menu = new StringSelectMenuBuilder()
        .setCustomId(LEAVE_IDS.halfStart)
        .setPlaceholder("Pick the start of your 3-hour window")
        .addOptions(HALF_DAY_STARTS.map((start) => new StringSelectMenuOptionBuilder().setLabel(`${start} – ${halfDayEnd(start)}`).setValue(start)));
    return new ActionRowBuilder().addComponents(menu);
}
/** "13:00" ⇄ "1300" for custom ids (":" separates the id's parts). */
export const halfStartToId = (start) => start.replace(":", "");
export const halfStartFromId = (raw) => (raw && /^\d{4}$/.test(raw) ? `${raw.slice(0, 2)}:${raw.slice(2)}` : null);
/** Ticket / list title: "Half-day leave 13:00–16:00", else the type's label. */
export function leaveTitle(row) {
    return leaveLabel(row, LEAVE_TYPES[row.type]?.label ?? row.type);
}
export function leaveModal(type, halfStart) {
    const def = LEAVE_TYPES[type];
    if (type === "half_day") {
        const start = halfStart && HALF_DAY_STARTS.includes(halfStart) ? halfStart : HALF_DAY_STARTS[0];
        const input = (id, label, ph, style) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(ph).setStyle(style).setRequired(true));
        return new ModalBuilder()
            .setCustomId(`${LEAVE_IDS.modal}:half_day:${halfStartToId(start)}`)
            .setTitle(halfDayLabel(start, halfDayEnd(start)))
            .addComponents(input("start_date", "Date (DD/MM/YYYY), a single day", "e.g. 10/07/2026", TextInputStyle.Short), input("reason", "Reason", "Briefly describe your reason", TextInputStyle.Paragraph));
    }
    const field = (id, label, ph) => new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId(id)
        .setLabel(label)
        .setPlaceholder(ph)
        .setStyle(id === "reason" ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(true));
    return new ModalBuilder()
        .setCustomId(`${LEAVE_IDS.modal}:${type}`)
        .setTitle(`${def.label}`.slice(0, 45))
        .addComponents(field("start_date", "Start date (DD/MM/YYYY)", "e.g. 10/07/2026"), field("end_date", "End date (DD/MM/YYYY)", "same as start for one day"), field("reason", "Reason", type === "exam" ? "Which exams / semester? (timetable in ticket)" : "Briefly describe your reason"));
}
/** Modal HR uses to enter the specific exam dates from the timetable. */
export function examApprovalModal(leaveId) {
    return new ModalBuilder()
        .setCustomId(`${LEAVE_IDS.examApproveModal}:${leaveId}`)
        .setTitle("Approve exam days")
        .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId("dates")
        .setLabel("Exam dates (DD/MM/YYYY, comma-separated)")
        .setPlaceholder("15/07/2026, 18/07/2026, 22/07/2026")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)));
}
/** Parse "15/07/2026, 18/07/2026" → ["2026-07-15", "2026-07-18"]. Returns null on any invalid entry. */
export function parseExamDates(raw) {
    const parts = raw.split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (const p of parts) {
        const m = p.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (!m)
            return null;
        const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
        if (mo < 1 || mo > 12 || d < 1 || d > 31)
            return null;
        // round-trip validate (rejects e.g. 31/02)
        const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const back = new Date(iso + "T00:00:00Z");
        if (back.getUTCFullYear() !== y ||
            back.getUTCMonth() + 1 !== mo ||
            back.getUTCDate() !== d)
            return null;
        out.push(iso);
    }
    return out.length ? Array.from(new Set(out)) : null;
}
/**
 * Validate policy (max days + prior notice). Document requirement is NOT
 * enforced here — the document is uploaded inside the private HR channel.
 */
/**
 * Outer bounds shared by every leave type, guarding against mistyped years
 * rather than against policy — the per-type rules below handle policy.
 */
const ABSURD_SPAN_DAYS = 90;
const MAX_FUTURE_DAYS = 180;
export function validateLeave(type, startAt, endAt, now = new Date()) {
    const def = LEAVE_TYPES[type];
    const span = inclusiveDaySpan(startAt, endAt);
    if (endAt.getTime() < startAt.getTime()) {
        return { ok: false, reason: "The end date is before the start date. Check the dates and try again." };
    }
    // Sanity bound on every type. A mistyped year (24/08/2027 for 24/08/2026)
    // used to pass validation on sick leave, which has no maxDays, and excused
    // the member from attendance for a whole year.
    if (span > ABSURD_SPAN_DAYS) {
        return {
            ok: false,
            reason: `That request spans ${span} days. Leave cannot exceed ${ABSURD_SPAN_DAYS} days — check the year on your dates.`,
        };
    }
    const aheadDays = Math.floor((startAt.getTime() - now.getTime()) / 86400_000);
    if (aheadDays > MAX_FUTURE_DAYS) {
        return {
            ok: false,
            reason: `That start date is ${aheadDays} days away. Leave cannot be requested more than ${MAX_FUTURE_DAYS} days ahead — check the year on your dates.`,
        };
    }
    // For casual/exam the max is hard. Sick may exceed 1 day (needs a certificate,
    // requested in the ticket), so don't hard-cap it.
    if (def.maxDays !== null && type !== "sick" && span > def.maxDays) {
        return {
            ok: false,
            reason: `${def.label} can be granted for at most ${def.maxDays} day${def.maxDays > 1 ? "s" : ""} (you requested ${span}).`,
        };
    }
    const noticeMs = startAt.getTime() - now.getTime();
    if (def.priorDays > 0 && noticeMs < def.priorDays * 86400_000) {
        return {
            ok: false,
            reason: `${def.label} requires at least ${def.priorDays} day${def.priorDays > 1 ? "s" : ""} prior notice.`,
        };
    }
    return { ok: true };
}
/**
 * Half day raised in Discord: one date and a 3 h window inside 11:30–19:00.
 * `endDate` (when given) must be the same date. Returns the stored instants.
 */
export function checkHalfDayRequest(startDate, endDate, start, now = new Date()) {
    const day = parseExamDates(startDate.trim());
    if (!day || day.length !== 1)
        return { ok: false, reason: "Invalid date. Use `DD/MM/YYYY` for a single day." };
    if (endDate !== null && endDate.trim() !== "" && endDate.trim() !== startDate.trim()) {
        const other = parseExamDates(endDate.trim());
        if (!other || other.length !== 1 || other[0] !== day[0]) {
            return { ok: false, reason: "A half day covers a single date. Use the same start and end date, or request full-day leave for a range." };
        }
    }
    if (!start)
        return { ok: false, reason: "Pick a start time for your half day (11:30 to 16:00)." };
    const end = halfDayEnd(start);
    const bad = halfWindowError(start, end);
    if (bad || !end) {
        return { ok: false, reason: `${bad ?? "Invalid start time."} Pick a start between 11:30 and 16:00; the window is 3 hours and ends by 19:00.` };
    }
    const { start: startAt, end: endAt } = halfWindowUtc(day[0], start, end);
    const check = validateLeave("half_day", startAt, endAt, now);
    if (!check.ok)
        return check;
    if (endAt.getTime() <= now.getTime())
        return { ok: false, reason: "That half-day window has already passed." };
    return { ok: true, startAt, endAt, half: { start, end } };
}
/** What document (if any) HR should request in the ticket for this leave. */
export function requiredDocument(type, startAt, endAt) {
    const def = LEAVE_TYPES[type];
    const span = inclusiveDaySpan(startAt, endAt);
    if (def.doc === "always")
        return def.docLabel;
    if (def.doc === "over1" && span > 1)
        return def.docLabel;
    return null;
}
function hrChannel(guild, name) {
    return guild.channels.cache.find((c) => c.type === ChannelType.GuildText &&
        c.name === name &&
        c.parent?.name === org.categories.hr.name);
}
export function leaveApprovalsChannel(guild) {
    return hrChannel(guild, "leave-approvals");
}
export function attendanceReportsChannel(guild) {
    return hrChannel(guild, "attendance-reports");
}
function staffRoleIds(guild) {
    return ["Founder", "Manager", "HR"]
        .map((n) => guild.roles.cache.find((r) => r.name === n)?.id)
        .filter((x) => !!x);
}
/**
 * Create a leave request and a PRIVATE channel between the member and HR under
 * the TICKETS category. The document (if required) is uploaded there — never in
 * a public channel. Returns the request id and channel id.
 */
export async function createLeaveRequest(member, type, startAt, endAt, reason, half) {
    const row = await prisma.leaveRequest.create({
        data: {
            guildId: member.guild.id,
            userId: member.id,
            type,
            startAt,
            endAt,
            reason,
            status: "pending",
            ...(half ? { halfDay: true, halfStart: half.start, halfEnd: half.end } : {}),
        },
    });
    const title = leaveTitle({ type, halfDay: Boolean(half), halfStart: half?.start, halfEnd: half?.end });
    const V = PermissionFlagsBits.ViewChannel;
    const S = PermissionFlagsBits.SendMessages;
    const A = PermissionFlagsBits.AttachFiles;
    const R = PermissionFlagsBits.ReadMessageHistory;
    const M = PermissionFlagsBits.ManageMessages;
    // Overflow-aware: never fails because TICKETS hit Discord's 50-channel cap.
    const ticketsCat = await ticketsCategoryWithRoom(member.guild).catch(() => undefined);
    const overwrites = [
        { id: member.guild.roles.everyone.id, deny: [V] },
        { id: member.id, allow: [V, S, A, R] },
        ...staffRoleIds(member.guild).map((id) => ({ id, allow: [V, S, A, R, M] })),
    ];
    let channelId = null;
    try {
        const channel = await member.guild.channels.create({
            name: `leave-${row.id}`,
            type: ChannelType.GuildText,
            parent: ticketsCat?.id,
            permissionOverwrites: overwrites,
            topic: `Leave #${row.id} · ${title} · ${member.id}`,
        });
        channelId = channel.id;
        await prisma.leaveRequest.update({ where: { id: row.id }, data: { channelId } });
        const embed = leaveTicketEmbed(row.id, member.id, title, startAt, endAt, reason, half);
        const buttons = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${LEAVE_IDS.approve}:${row.id}`).setLabel("Approve").setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`${LEAVE_IDS.reject}:${row.id}`).setLabel("Reject").setStyle(ButtonStyle.Danger));
        const doc = requiredDocument(type, startAt, endAt);
        const hrMention = staffRoleIds(member.guild)
            .map((id) => `<@&${id}>`)
            .join(" ");
        await channel.send({ content: `<@${member.id}> ${hrMention}`, embeds: [embed], components: [buttons] });
        if (doc) {
            await channel.send(`<@${member.id}>, please upload your ${doc} in this channel so HR can review it.`);
        }
        // Summary line for HR in #leave-approvals. It deliberately carries no link
        // to the private ticket: that channel is deleted once the request is
        // decided, which left every older pointer rendering as "#unknown".
        const approvals = leaveApprovalsChannel(member.guild);
        if (approvals) {
            await approvals
                .send(`New ${title} Request **#${row.id}** from ${member.displayName} for ${leaveSpan(startAt, endAt, half)}`)
                .catch(() => { });
        }
    }
    catch (err) {
        logger.warn({ err, leave: row.id }, "Could not create leave channel");
    }
    return { id: row.id, channelId };
}
/** "10 Jul 2026, 13:00–16:00" for a half day, else the usual "(n days)" span. */
export function leaveSpan(startAt, endAt, half) {
    if (!half)
        return formatDuration(startAt, endAt);
    return `${formatDateInTz(startAt)}, ${half.start}–${half.end}`;
}
/** The private HR leave ticket's card. A half day reads "Half-day leave 13:00–16:00" with the date and window. */
export function leaveTicketEmbed(id, userId, title, startAt, endAt, reason, half) {
    const embed = new EmbedBuilder()
        .setTitle(half ? `${title} · Request #${id}` : `Leave Request #${id} · ${title}`)
        .setColor(0xfaa61a);
    if (half) {
        embed
            .addFields({ name: "Member", value: `<@${userId}>`, inline: true }, { name: "Date", value: formatDateInTz(startAt), inline: true }, { name: "Window (IST)", value: `${half.start}–${half.end}`, inline: true }, { name: "Reason", value: reason })
            .setDescription("Half day: only this window is excused. The rest of the day is a normal working day.");
    }
    else {
        embed.addFields({ name: "Member", value: `<@${userId}>`, inline: true }, { name: "From", value: formatInTz(startAt), inline: true }, { name: "To", value: formatInTz(endAt), inline: true }, { name: "Reason", value: reason });
    }
    return embed.setFooter({ text: "HR: approve or reject below" }).setTimestamp(new Date());
}
export async function decideLeave(id, approve, reviewerId, approvedDays) {
    const row = await prisma.leaveRequest.findUnique({ where: { id } });
    if (!row || row.status !== "pending")
        return null;
    const status = approve ? "approved" : "rejected";
    const stored = approve && approvedDays && approvedDays.length > 0 ? approvedDays.join(",") : null;
    await prisma.leaveRequest.update({
        where: { id },
        data: {
            status,
            reviewedById: reviewerId,
            reviewedAt: new Date(),
            approvedDays: stored,
        },
    });
    return {
        userId: row.userId,
        status,
        type: row.type,
        startAt: row.startAt,
        endAt: row.endAt,
        channelId: row.channelId,
        approvedDays: stored ? stored.split(",") : null,
        half: row.halfDay && row.halfStart && row.halfEnd ? { start: row.halfStart, end: row.halfEnd } : null,
    };
}
/**
 * True if an approved leave covers the given instant — matched by CALENDAR DAY
 * in the configured timezone. For leaves with `approvedDays` set (exam leave),
 * only those specific days count as excused, not the full requested range.
 * A half-day leave covers only its 3 h window on that day.
 */
export async function hasApprovedLeaveCovering(guildId, userId, at) {
    const rows = await prisma.leaveRequest.findMany({
        where: { guildId, userId, status: "approved" },
        select: { startAt: true, endAt: true, approvedDays: true, halfDay: true, halfStart: true, halfEnd: true },
    });
    // A half day covers only its window: a meeting outside it is not excused.
    return rows.some((r) => leaveCoversAt(r, at));
}
export function listLeaves(guildId, userId) {
    return prisma.leaveRequest.findMany({
        where: { guildId, userId },
        orderBy: { createdAt: "desc" },
        take: 15,
    });
}
export function pendingLeaves(guildId) {
    return prisma.leaveRequest.findMany({
        where: { guildId, status: "pending" },
        orderBy: { createdAt: "asc" },
        take: 20,
    });
}
//# sourceMappingURL=leave.js.map