import express from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { prisma } from "../../core/db.js";
import { logger } from "../../core/logger.js";
import { EMS_APPROVER, LeaveInputError, grantManualLeave, leaveDays, leaveOrigin, revokeManualLeave } from "../../services/manualLeave.js";
import { WarningError, revokeWarning, sendWarning } from "../../services/warnings.js";
import { halfWindowError, halfWindowOf } from "../../lib/halfDay.js";
/**
 * HR actions sync with EMS (spec 2026-11-03 §6, §7), behind the v1 Bearer guard. EMS holds the sync logic.
 *   GET  /warnings?updatedSince=&afterId=   every issued warning except ladder mirrors, oldest change first, 500 a page
 *   POST /warnings                          issue from EMS (source "ems-hr"), DMs the member; a repeated uid changes nothing
 *   POST /warnings/:uid/withdraw            revoke; already withdrawn is success; a ladder mirror is 409
 *   GET  /leaves?updatedSince=&afterId=     every decided leave, same paging
 *   POST /leaves                            grant from EMS; a repeated uid changes nothing
 *     (half day: halfDay true + halfStart/halfEnd "HH:MM" IST, one day, 3 h inside 11:30–19:00; list items carry the same)
 *   POST /leaves/:uid/revoke                revoke; already inactive is success; a Discord approval is 409 (DIS only)
 */
export const warningsRouter = express.Router();
export const leavesRouter = express.Router();
const json = express.json({ limit: "16kb" });
const PAGE = 500;
const uidSchema = z.string().uuid();
const discordId = z.string().regex(/^\d{15,25}$/, "must be a Discord id");
const name = z.string().trim().min(2).max(80);
const fail = (res, status, error, message) => res.status(status).json({ error, message });
const invalid = (res, err) => fail(res, 400, "invalid", err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
/** The page after (updatedAt, id), or everything at or after updatedSince. Null when the query is unusable. */
function pageWhere(query) {
    const since = typeof query.updatedSince === "string" ? new Date(query.updatedSince) : new Date(0);
    if (Number.isNaN(since.getTime()))
        return null;
    if (query.afterId === undefined)
        return { updatedAt: { gte: since } };
    const afterId = Number(query.afterId);
    if (!Number.isInteger(afterId) || afterId < 0)
        return null;
    return { OR: [{ updatedAt: { gt: since } }, { updatedAt: since, id: { gt: afterId } }] };
}
const warnDto = (w) => ({
    id: w.id, uid: w.externalUid, discordUserId: w.userId, source: w.source, kind: w.kind, status: w.status, reason: w.reason,
    issuedBy: w.issuedBy, reviewedBy: w.reviewedBy, modId: w.modId, createdAt: w.createdAt, sentAt: w.sentAt, updatedAt: w.updatedAt,
});
warningsRouter.get("/", async (req, res) => {
    const where = pageWhere(req.query);
    if (!where)
        return fail(res, 400, "invalid", "updatedSince must be an ISO date and afterId a row id.");
    const rows = await prisma.warn.findMany({
        where: { guildId: env.DISCORD_GUILD_ID, status: { not: "proposed" }, NOT: { source: "ems" }, ...where },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: PAGE,
    });
    return res.json(rows.map(warnDto));
});
const issueSchema = z.object({
    uid: uidSchema,
    discordUserId: discordId,
    kind: z.enum(["hours", "conduct", "other"]),
    reason: z.string().trim().min(5).max(1500),
    issuedBy: name,
});
warningsRouter.post("/", json, async (req, res) => {
    const parsed = issueSchema.safeParse(req.body ?? {});
    if (!parsed.success)
        return invalid(res, parsed.error);
    const b = parsed.data;
    const member = await prisma.member.findUnique({ where: { id: b.discordUserId }, select: { guildId: true } });
    if (!member || member.guildId !== env.DISCORD_GUILD_ID)
        return fail(res, 422, "not_in_guild", "This person is not a known Discord member.");
    const row = (await prisma.warn.findUnique({ where: { externalUid: b.uid } })) ??
        (await prisma.warn.create({
            data: {
                guildId: env.DISCORD_GUILD_ID, userId: b.discordUserId, modId: `ems:${b.issuedBy}`.slice(0, 190), source: "ems-hr", kind: b.kind,
                status: "proposed", issuedBy: b.issuedBy, reason: b.reason, externalUid: b.uid,
            },
        }));
    // A row still "proposed" means an earlier send never finished: send it now. Anything else was already delivered.
    if (row.status !== "proposed")
        return res.json(warnDto(row));
    try {
        await sendWarning(row.id, b.issuedBy);
    }
    catch (err) {
        if (err instanceof WarningError)
            return fail(res, 503, "bot_unavailable", err.message);
        throw err;
    }
    logger.info({ warn: row.id, by: b.issuedBy }, "Warning issued from EMS");
    const sent = await prisma.warn.findUnique({ where: { id: row.id } });
    return res.status(201).json(warnDto(sent));
});
const withdrawSchema = z.object({ by: name, reason: z.string().trim().min(3).max(1000) });
warningsRouter.post("/:uid/withdraw", json, async (req, res) => {
    const uid = uidSchema.safeParse(req.params.uid);
    if (!uid.success)
        return fail(res, 400, "invalid", "uid must be a UUID.");
    const parsed = withdrawSchema.safeParse(req.body ?? {});
    if (!parsed.success)
        return invalid(res, parsed.error);
    const w = await prisma.warn.findUnique({ where: { externalUid: uid.data } });
    if (!w || w.guildId !== env.DISCORD_GUILD_ID)
        return fail(res, 404, "not_found", "No warning with this uid.");
    if (w.source === "ems")
        return fail(res, 409, "ladder_managed", "A ladder warning is withdrawn through the ladder.");
    if (w.status === "revoked" || w.status === "dismissed")
        return res.json(warnDto(w));
    try {
        await revokeWarning(w.id, w.guildId, parsed.data.by, parsed.data.reason);
    }
    catch (err) {
        if (err instanceof WarningError)
            return fail(res, 409, "invalid_state", err.message);
        throw err;
    }
    logger.info({ warn: w.id, by: parsed.data.by }, "Warning withdrawn from EMS");
    return res.json(warnDto((await prisma.warn.findUnique({ where: { id: w.id } }))));
});
const leaveDto = (l) => {
    const half = halfWindowOf(l);
    return {
        id: l.id, uid: l.uid, discordUserId: l.userId, type: l.type, status: l.status, days: leaveDays(l), reason: l.reason,
        origin: leaveOrigin(l.reviewedById), reviewedById: l.reviewedById, reviewedAt: l.reviewedAt, updatedAt: l.updatedAt,
        halfDay: half !== null,
        ...(half ? { halfStart: half.start, halfEnd: half.end } : {}),
    };
};
leavesRouter.get("/", async (req, res) => {
    const where = pageWhere(req.query);
    if (!where)
        return fail(res, 400, "invalid", "updatedSince must be an ISO date and afterId a row id.");
    const rows = await prisma.leaveRequest.findMany({
        where: { guildId: env.DISCORD_GUILD_ID, status: { not: "pending" }, ...where },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: PAGE,
    });
    return res.json(rows.map(leaveDto));
});
const grantSchema = z.object({
    uid: uidSchema,
    discordUserId: discordId,
    type: z.enum(["casual", "sick", "exam"]),
    days: z.array(z.string()).min(1).max(31),
    reason: z.string().trim().min(3).max(500),
    by: name,
    halfDay: z.boolean().optional(),
    halfStart: z.string().optional(),
    halfEnd: z.string().optional(),
}).superRefine((b, ctx) => {
    if (b.halfDay !== true)
        return;
    if (b.days.length !== 1)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["days"], message: "a half day is a single date" });
    const bad = halfWindowError(b.halfStart, b.halfEnd);
    if (bad)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["halfStart"], message: bad });
});
leavesRouter.post("/", json, async (req, res) => {
    const parsed = grantSchema.safeParse(req.body ?? {});
    if (!parsed.success)
        return invalid(res, parsed.error);
    const b = parsed.data;
    const existing = await prisma.leaveRequest.findUnique({ where: { uid: b.uid } });
    if (existing)
        return res.json(leaveDto(existing));
    try {
        const out = await grantManualLeave(env.DISCORD_GUILD_ID, b.discordUserId, {
            dates: b.days, type: b.type, reason: b.reason, approvedBy: `${EMS_APPROVER}${b.by}`.slice(0, 60),
            ...(b.halfDay ? { half: { start: b.halfStart, end: b.halfEnd } } : {}),
        }, { uid: b.uid });
        logger.info({ leave: out.id, by: b.by }, "Leave granted from EMS");
        return res.status(201).json(leaveDto((await prisma.leaveRequest.findUnique({ where: { id: out.id } }))));
    }
    catch (err) {
        if (err instanceof LeaveInputError)
            return fail(res, 422, "invalid_leave", err.message);
        throw err;
    }
});
leavesRouter.post("/:uid/revoke", async (req, res) => {
    const uid = uidSchema.safeParse(req.params.uid);
    if (!uid.success)
        return fail(res, 400, "invalid", "uid must be a UUID.");
    const row = await prisma.leaveRequest.findUnique({ where: { uid: uid.data } });
    if (!row || row.guildId !== env.DISCORD_GUILD_ID)
        return fail(res, 404, "not_found", "No leave with this uid.");
    if (row.status !== "approved")
        return res.json(leaveDto(row));
    if (leaveOrigin(row.reviewedById) === "discord")
        return fail(res, 409, "discord_approved", "Approved in Discord. Revoke it in DIS.");
    try {
        await revokeManualLeave(row.guildId, row.userId, row.id);
    }
    catch (err) {
        if (err instanceof LeaveInputError)
            return fail(res, 409, "invalid_state", err.message);
        throw err;
    }
    logger.info({ leave: row.id }, "Leave revoked from EMS");
    return res.json(leaveDto((await prisma.leaveRequest.findUnique({ where: { id: row.id } }))));
});
//# sourceMappingURL=hrSync.js.map