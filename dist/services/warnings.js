import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, } from "discord.js";
import { prisma } from "../core/db.js";
import { org } from "../config/loader.js";
import { logger } from "../core/logger.js";
import { botClient, botGuild } from "../core/botClient.js";
import { shiftDayKey, tzDateKey, tzDayStartUtc } from "../lib/time.js";
import { buildCalendars } from "./calendar.js";
import { shortStreak } from "../lib/streak.js";
/**
 * Formal warnings and the three-strike rule.
 *
 * Hours warnings come from a sweep: a registered member whose last N settled
 * working days (leave and holidays skipped) were all short of the hours target
 * or absent gets one warning for that streak. In "review" mode the sweep only
 * drafts them (status "proposed"); HR sends from the dashboard. Every sent
 * warning is a DM with an Acknowledge button and a deadline. Warnings that were
 * sent (acknowledged or not) count as strikes; reaching the limit puts the
 * member up for termination: reviewed by HR, or automatic in "strict" mode.
 */
const ACK_PREFIX = "warn:ack:";
const STRIKE_STATUSES = ["sent", "dm-failed", "acknowledged"];
export class WarningError extends Error {
}
function cfg() {
    return org.enforcement;
}
function hm(seconds) {
    const s = Math.max(0, Math.round(seconds));
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}
function localTimeOn(day, hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    return new Date(tzDayStartUtc(day).getTime() + ((h ?? 0) * 60 + (m ?? 0)) * 60_000);
}
/** Last day whose verdict is final (today only once the window has closed). */
export function settledThrough(now = new Date()) {
    const today = tzDateKey(now);
    return now >= localTimeOn(today, org.attendancePolicy.windowEnd) ? today : shiftDayKey(today, -1);
}
function dayLabel(day) {
    return new Date(day + "T00:00:00Z").toLocaleDateString("en-IN", {
        weekday: "short",
        day: "numeric",
        month: "short",
        timeZone: "UTC",
    });
}
export async function strikeCount(guildId, userId) {
    return prisma.warn.count({ where: { guildId, userId, status: { in: STRIKE_STATUSES } } });
}
export async function runHoursSweep(guildId) {
    const c = cfg();
    const settled = settledThrough();
    const start = [c.startsOn, org.attendancePolicy.trackingStartsOn, shiftDayKey(settled, -30)]
        .filter((d) => Boolean(d))
        .sort()
        .pop();
    const out = { checked: 0, created: 0, sent: 0, terminated: 0 };
    if (start > settled)
        return out;
    const required = Math.round(org.attendancePolicy.minHours * 3600);
    const [calendars, existing] = await Promise.all([
        buildCalendars(guildId, {}, start, settled),
        prisma.warn.findMany({
            where: { guildId, kind: "hours", status: { not: "dismissed" } },
            select: { userId: true, days: true },
        }),
    ]);
    const covered = new Map();
    for (const w of existing) {
        const set = covered.get(w.userId) ?? new Set();
        for (const d of (w.days ?? "").split(","))
            if (d)
                set.add(d);
        covered.set(w.userId, set);
    }
    for (const cal of calendars) {
        if (!cal.project)
            continue; // unregistered accounts aren't interns yet
        out.checked++;
        const streak = shortStreak(cal.days, {
            settled,
            n: c.consecutiveShortDays,
            requiredSeconds: required,
            covered: covered.get(cal.userId) ?? new Set(),
            startsOn: c.startsOn,
        });
        if (!streak)
            continue;
        const lines = streak.map((d) => d.absent ? `${dayLabel(d.day)}: absent (no voice presence)` : `${dayLabel(d.day)}: served ${hm(d.seconds)} of ${hm(required)}`);
        const row = await prisma.warn.create({
            data: {
                guildId,
                userId: cal.userId,
                modId: "system",
                source: "auto",
                kind: "hours",
                status: "proposed",
                days: streak.map((d) => d.day).join(","),
                issuedBy: "Attendance system",
                reason: `Did not complete the required ${org.attendancePolicy.minHours} hours on ${streak.length} consecutive working days.\n${lines.join("\n")}`,
            },
        });
        out.created++;
        if (c.mode === "strict" && botClient()) {
            const sent = await sendWarning(row.id).catch(() => null);
            if (sent)
                out.sent++;
        }
    }
    if (c.mode === "strict" && botClient()) {
        for (const cand of await terminationCandidates(guildId)) {
            await terminateMember(guildId, cand.userId, "Attendance system (strict mode)").catch((err) => logger.error({ err, userId: cand.userId }, "Automatic termination failed"));
            out.terminated++;
        }
    }
    if (out.created)
        logger.info({ guildId, ...out, mode: c.mode }, "Hours warning sweep");
    return out;
}
// ------------------------------------------------------------------ sending
export async function sendWarning(id) {
    const w = await prisma.warn.findUnique({ where: { id } });
    if (!w)
        throw new WarningError("Warning not found.");
    if (w.status !== "proposed" && w.status !== "dm-failed")
        throw new WarningError("This warning was already sent.");
    const client = botClient();
    if (!client)
        throw new WarningError("The bot isn't connected in this process, so DMs can't be sent.");
    const c = cfg();
    const member = await prisma.member.findUnique({ where: { id: w.userId }, select: { fullName: true, project: true } });
    const strikesBefore = await strikeCount(w.guildId, w.userId);
    const number = strikesBefore + 1;
    const ackDueAt = new Date(Date.now() + c.ackHours * 3600_000);
    const guildName = botGuild(w.guildId)?.name ?? "CyArt";
    const embed = new EmbedBuilder()
        .setColor(number >= c.strikeLimit ? 0xe11d48 : 0xf97316)
        .setTitle(w.kind === "hours" ? "Formal Warning: Attendance Non-Compliance" : "Formal Warning")
        .setDescription([
        `Dear ${member?.fullName ?? "Intern"},`,
        "",
        `This is formal warning **${number} of ${c.strikeLimit}** issued to you by ${guildName} HR.`,
        "",
        `**Reason**\n${w.reason}`,
        "",
        w.kind === "hours"
            ? `**Policy**\nEvery working day you must join voice by **${org.attendancePolicy.loginBy}** and serve at least **${org.attendancePolicy.minHours} hours**.`
            : null,
        `**Action required**\nPress **Acknowledge** below within **${c.ackHours} hours** (by <t:${Math.floor(ackDueAt.getTime() / 1000)}:f>).`,
        "",
        `Reaching **${c.strikeLimit} warnings** results in termination of your internship for non-compliance and violation of regulations, and removal from the server.`,
    ]
        .filter((l) => l !== null)
        .join("\n"))
        .setFooter({ text: `Warning #${w.id} · ${member?.project ?? ""}`.trim() })
        .setTimestamp(new Date());
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${ACK_PREFIX}${w.id}`).setLabel("Acknowledge").setStyle(ButtonStyle.Primary));
    try {
        const user = await client.users.fetch(w.userId);
        const msg = await user.send({ embeds: [embed], components: [row] });
        await prisma.warn.update({
            where: { id },
            data: { status: "sent", sentAt: new Date(), ackDueAt, dmChannelId: msg.channelId, dmMessageId: msg.id },
        });
        return { status: "sent" };
    }
    catch (err) {
        // DMs closed or user gone: the warning still stands on record.
        logger.warn({ err, warn: id }, "Warning DM failed");
        await prisma.warn.update({ where: { id }, data: { status: "dm-failed", sentAt: new Date(), ackDueAt } });
        return { status: "dm-failed" };
    }
}
let bulkRunning = false;
/** Send every drafted warning, spaced out so Discord's DM limits aren't hit. */
export async function sendAllProposed(guildId) {
    if (!botClient())
        throw new WarningError("The bot isn't connected in this process, so DMs can't be sent.");
    if (bulkRunning)
        throw new WarningError("A bulk send is already running.");
    const ids = (await prisma.warn.findMany({ where: { guildId, status: "proposed" }, select: { id: true }, orderBy: { id: "asc" } })).map((w) => w.id);
    bulkRunning = true;
    void (async () => {
        for (const id of ids) {
            await sendWarning(id).catch((err) => logger.warn({ err, warn: id }, "Bulk warning send failed"));
            await new Promise((r) => setTimeout(r, 1500));
        }
    })().finally(() => {
        bulkRunning = false;
    });
    return { queued: ids.length };
}
export async function createManualWarning(guildId, input) {
    const userId = String(input.userId ?? "");
    const reason = String(input.reason ?? "").trim();
    const kind = ["hours", "conduct", "other"].includes(String(input.kind)) ? String(input.kind) : "other";
    const issuedBy = String(input.issuedBy ?? "").trim();
    if (!/^\d{5,25}$/.test(userId))
        throw new WarningError("Pick a member.");
    if (reason.length < 5 || reason.length > 1500)
        throw new WarningError("Reason must be 5–1500 characters.");
    if (issuedBy.length < 2 || issuedBy.length > 80)
        throw new WarningError("Enter your name as the issuer.");
    const member = await prisma.member.findUnique({ where: { id: userId }, select: { guildId: true } });
    if (!member || member.guildId !== guildId)
        throw new WarningError("Member not found.");
    const row = await prisma.warn.create({
        data: { guildId, userId, modId: `dashboard:${issuedBy}`, source: "manual", kind, status: "proposed", issuedBy, reason },
    });
    // Issued by a person: send now when the bot is here, otherwise it waits as a draft.
    if (!botClient())
        return { id: row.id, status: "proposed" };
    return { id: row.id, ...(await sendWarning(row.id)) };
}
export async function dismissWarning(id, guildId) {
    const w = await prisma.warn.findUnique({ where: { id } });
    if (!w || w.guildId !== guildId)
        throw new WarningError("Warning not found.");
    await prisma.warn.update({ where: { id }, data: { status: "dismissed" } });
}
// --------------------------------------------------------------- reporting
export async function listWarnings(guildId) {
    const rows = await prisma.warn.findMany({ where: { guildId }, orderBy: { createdAt: "desc" }, take: 1000 });
    const ids = [...new Set(rows.map((r) => r.userId))];
    const members = await prisma.member.findMany({
        where: { id: { in: ids } },
        select: { id: true, fullName: true, displayName: true, tag: true, project: true, batch: true, module: true, pod: true },
    });
    const byId = new Map(members.map((m) => [m.id, m]));
    const strikes = new Map();
    for (const r of rows)
        if (STRIKE_STATUSES.includes(r.status))
            strikes.set(r.userId, (strikes.get(r.userId) ?? 0) + 1);
    const now = Date.now();
    return {
        mode: cfg().mode,
        strikeLimit: cfg().strikeLimit,
        ackHours: cfg().ackHours,
        consecutiveShortDays: cfg().consecutiveShortDays,
        startsOn: cfg().startsOn ?? null,
        botConnected: Boolean(botClient()),
        warnings: rows.map((r) => {
            const m = byId.get(r.userId);
            return {
                id: r.id,
                userId: r.userId,
                fullName: m?.fullName ?? m?.displayName ?? m?.tag ?? r.userId,
                project: m?.project ?? null,
                batch: m?.batch ?? null,
                source: r.source,
                kind: r.kind,
                status: r.status,
                reason: r.reason,
                days: r.days ? r.days.split(",") : [],
                issuedBy: r.issuedBy ?? (r.modId === "system" ? "Attendance system" : r.modId),
                createdAt: r.createdAt,
                sentAt: r.sentAt,
                ackDueAt: r.ackDueAt,
                acknowledgedAt: r.acknowledgedAt,
                overdue: r.status === "sent" && r.ackDueAt !== null && r.ackDueAt.getTime() < now,
                strikes: strikes.get(r.userId) ?? 0,
            };
        }),
    };
}
export async function terminationCandidates(guildId) {
    const limit = cfg().strikeLimit;
    const grouped = await prisma.warn.groupBy({
        by: ["userId"],
        where: { guildId, status: { in: STRIKE_STATUSES } },
        _count: { _all: true },
    });
    const over = grouped.filter((g) => g._count._all >= limit).map((g) => g.userId);
    if (!over.length)
        return [];
    const [members, done] = await Promise.all([
        prisma.member.findMany({
            where: { id: { in: over } },
            select: { id: true, fullName: true, displayName: true, tag: true, project: true, batch: true },
        }),
        prisma.termination.findMany({ where: { guildId, userId: { in: over }, kicked: true }, select: { userId: true } }),
    ]);
    const terminated = new Set(done.map((d) => d.userId));
    const count = new Map(grouped.map((g) => [g.userId, g._count._all]));
    return members
        .filter((m) => !terminated.has(m.id))
        .map((m) => ({
        userId: m.id,
        fullName: m.fullName ?? m.displayName ?? m.tag ?? m.id,
        project: m.project,
        batch: m.batch,
        strikes: count.get(m.id) ?? 0,
    }));
}
export async function listTerminations(guildId) {
    return prisma.termination.findMany({ where: { guildId }, orderBy: { createdAt: "desc" }, take: 200 });
}
// --------------------------------------------------------------- termination
export async function terminateMember(guildId, userId, by) {
    const guild = botGuild(guildId);
    if (!guild)
        throw new WarningError("The bot isn't connected in this process, so members can't be removed.");
    const strikes = await prisma.warn.findMany({
        where: { guildId, userId, status: { in: STRIKE_STATUSES } },
        select: { id: true },
    });
    if (strikes.length < cfg().strikeLimit) {
        throw new WarningError(`Member has ${strikes.length} warning(s); termination needs ${cfg().strikeLimit}.`);
    }
    const member = await prisma.member.findUnique({ where: { id: userId }, select: { fullName: true } });
    const reason = `Internship terminated: ${strikes.length} formal warnings for non-compliance and violation of regulations.`;
    let kicked = false;
    let error = null;
    const gm = await guild.members.fetch(userId).catch(() => null);
    if (!gm)
        error = "Member is no longer in the server.";
    else if (!gm.kickable)
        error = "Bot lacks permission or role position to remove this member.";
    else {
        await gm
            .send({
            embeds: [
                new EmbedBuilder()
                    .setColor(0xe11d48)
                    .setTitle("Internship Terminated")
                    .setDescription(`Dear ${member?.fullName ?? "Intern"},\n\nAfter **${strikes.length} formal warnings**, your internship with ${guild.name} has been terminated due to non-compliance and violation of regulations. You will now be removed from the server.\n\nFor any queries, please contact HR.`)
                    .setTimestamp(new Date()),
            ],
        })
            .catch(() => { });
        try {
            await gm.kick(reason);
            kicked = true;
        }
        catch (err) {
            error = err.message;
        }
    }
    await prisma.termination.create({
        data: {
            guildId,
            userId,
            fullName: member?.fullName ?? null,
            reason,
            warnIds: strikes.map((s) => s.id).join(","),
            by: by.slice(0, 80),
            kicked,
            error,
        },
    });
    logger.info({ userId, kicked, error, by }, "Termination processed");
    return { kicked, error };
}
// ----------------------------------------------------------- acknowledgement
export const warningAckHandler = {
    id: "warning-ack",
    matches: (i) => i.isButton() && i.customId.startsWith(ACK_PREFIX),
    async handle(i) {
        if (!i.isButton())
            return;
        const id = Number(i.customId.slice(ACK_PREFIX.length));
        const w = Number.isInteger(id) ? await prisma.warn.findUnique({ where: { id } }) : null;
        if (!w || w.userId !== i.user.id) {
            await i.reply({ content: "This warning isn't addressed to you.", flags: MessageFlags.Ephemeral });
            return;
        }
        if (w.status === "acknowledged") {
            await i.reply({ content: "You have already acknowledged this warning.", flags: MessageFlags.Ephemeral });
            return;
        }
        const now = new Date();
        await prisma.warn.update({ where: { id }, data: { status: "acknowledged", acknowledgedAt: now } });
        const late = w.ackDueAt && now > w.ackDueAt;
        const done = new ActionRowBuilder().addComponents(new ButtonBuilder()
            .setCustomId(`${ACK_PREFIX}${id}:done`)
            .setLabel(late ? "Acknowledged (late)" : "Acknowledged")
            .setStyle(ButtonStyle.Success)
            .setDisabled(true));
        await i.update({ components: [done] });
        await i.followUp({
            content: `Thank you. Warning #${id} is acknowledged${late ? " (after the deadline)" : ""}. Please make sure to follow the attendance rules from now on.`,
        });
    },
};
// --------------------------------------------------------------------- loop
let timer = null;
export function startWarningSweep(client) {
    if (timer)
        clearInterval(timer);
    const tick = async () => {
        for (const guild of client.guilds.cache.values()) {
            await runHoursSweep(guild.id).catch((err) => logger.error({ err, guild: guild.id }, "Hours warning sweep failed"));
        }
    };
    timer = setInterval(() => void tick(), 30 * 60_000);
    setTimeout(() => void tick(), 60_000).unref?.();
    logger.info({ mode: cfg().mode }, "Warning sweep started (every 30 min)");
}
export function stopWarningSweep() {
    if (timer)
        clearInterval(timer);
    timer = null;
}
//# sourceMappingURL=warnings.js.map