import express from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { findProject, org } from "../../config/loader.js";
import { botGuild } from "../../core/botClient.js";
import { logger } from "../../core/logger.js";
import { assignPodRep, podRepHolders, removePodRep, PodHasRepError } from "../../services/leadership.js";
import { leadershipAfterChange } from "../../services/integrationPayloads.js";
import { roleNames } from "../../lib/names.js";
/**
 * Pod Rep changes asked for by EMS (sub-project C §5), mounted at /api/v1/reps behind the v1 Bearer guard. EMS has
 * already checked who may do it; the bot owns the "<Project> M<m> P<n> Representative" role and enforces one rep per pod.
 *   POST   /  { discordUserId, projectKey, moduleNum, podNum, replace?, actor? }  → 200 { ok, applied, replaced, leadership, replacedLeadership }
 *                                                                               409 pod_has_rep { current: [{ discordUserId, name }] }
 *   DELETE /  { discordUserId, projectKey, moduleNum, podNum, reason, actor? }  → 200 { ok, removed, leadership }
 * Other errors: 400 invalid, 422 unknown_pod | not_in_guild | rep_role_missing, 502 role_change_failed, 503 bot_offline | bot_unavailable.
 * These changes are not sent back to EMS as events (EMS logged them itself).
 */
export const repsRouter = express.Router();
repsRouter.use(express.json({ limit: "16kb" }));
const discordId = z.string().regex(/^\d{15,25}$/, "must be a Discord id");
const actorSchema = z.object({ emsUserId: z.number().int().positive().optional(), name: z.string().trim().min(1).max(100) }).optional();
const podFields = {
    discordUserId: discordId,
    projectKey: z.string().trim().min(1).max(64),
    moduleNum: z.number().int().min(1).max(50),
    podNum: z.number().int().min(1).max(50),
    actor: actorSchema,
};
const assignSchema = z.object({ ...podFields, replace: z.boolean().optional().default(false) });
const removeSchema = z.object({ ...podFields, reason: z.string().trim().min(3).max(500) });
const fail = (res, status, error, message, extra = {}) => res.status(status).json({ error, message, ...extra });
const invalid = (res, err) => fail(res, 400, "invalid", "Request body is invalid.", { issues: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`) });
/** Leadership after a change: the role cache lags roles.add / remove, so apply the change to the cached names. */
const leadershipOf = (m, added = [], removed = []) => leadershipAfterChange([...m.roles.cache.values()].map((r) => r.name), added, removed, org.projects);
const nameOf = (m) => m.displayName ?? m.id;
const emsActor = (a) => ({ emsName: a?.name ?? "EMS" });
/** Guild + project + pod + member, or the error response already sent (null). */
async function resolve(res, b) {
    const guild = botGuild(env.DISCORD_GUILD_ID);
    if (!guild) {
        fail(res, 503, "bot_offline", "The bot is offline; try again later.");
        return null;
    }
    const p = findProject(b.projectKey);
    if (!p || b.moduleNum > p.modules || b.podNum > p.podsPerModule) {
        fail(res, 422, "unknown_pod", `${p ? p.name : b.projectKey} has no pod M${b.moduleNum} P${b.podNum}.`);
        return null;
    }
    try {
        return { guild, p, member: await guild.members.fetch({ user: b.discordUserId, force: true }) };
    }
    catch (err) {
        if (err?.code === 10007)
            fail(res, 422, "not_in_guild", "This person is not in the Discord server.");
        else {
            logger.warn({ err, user: b.discordUserId }, "v1 reps: member lookup failed");
            fail(res, 503, "bot_unavailable", `Discord lookup failed: ${String(err?.message ?? err).slice(0, 200)}`);
        }
        return null;
    }
}
repsRouter.post("/", async (req, res) => {
    const parsed = assignSchema.safeParse(req.body ?? {});
    if (!parsed.success)
        return invalid(res, parsed.error);
    const b = parsed.data;
    const r = await resolve(res, b);
    if (!r)
        return;
    const holders = podRepHolders(r.guild, r.p.key, b.moduleNum, b.podNum, r.member.id);
    if (holders.length && !b.replace) {
        return fail(res, 409, "pod_has_rep", `${r.p.name} M${b.moduleNum} P${b.podNum} already has a representative.`, {
            current: holders.map((h) => ({ discordUserId: h.id, name: nameOf(h) })),
        });
    }
    try {
        const repName = roleNames.podRep(r.p, b.moduleNum, b.podNum);
        const applied = await assignPodRep({ member: r.member, projectKey: r.p.key, moduleNum: b.moduleNum, podNum: b.podNum, actor: emsActor(b.actor), replace: b.replace });
        return res.json({
            ok: true, applied, replaced: holders.map((h) => h.id), leadership: leadershipOf(r.member, applied),
            replacedLeadership: holders.map((h) => ({ discordUserId: h.id, leadership: leadershipOf(h, [], [repName]) })),
        });
    }
    catch (err) {
        if (err instanceof PodHasRepError) {
            return fail(res, 409, "pod_has_rep", err.message, { current: err.holders.map((h) => ({ discordUserId: h.id, name: nameOf(h) })) });
        }
        const message = String(err?.message ?? err).slice(0, 200);
        if (/Rep role missing/.test(message))
            return fail(res, 422, "rep_role_missing", message);
        logger.error({ err, user: b.discordUserId }, "v1 reps: assign failed");
        return fail(res, 502, "role_change_failed", `Discord refused the role change: ${message}`);
    }
});
repsRouter.delete("/", async (req, res) => {
    const parsed = removeSchema.safeParse(req.body ?? {});
    if (!parsed.success)
        return invalid(res, parsed.error);
    const b = parsed.data;
    const r = await resolve(res, b);
    if (!r)
        return;
    const { removed, failed } = await removePodRep({
        member: r.member, actor: emsActor(b.actor), projectKey: r.p.key, moduleNum: b.moduleNum, podNum: b.podNum, reason: b.reason,
    });
    if (failed.length)
        return fail(res, 502, "role_change_failed", `Discord refused to remove: ${failed.join(", ")}`);
    return res.json({ ok: true, removed, leadership: leadershipOf(r.member, [], removed) });
});
//# sourceMappingURL=reps.js.map