import express from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { org } from "../../config/loader.js";
import { prisma } from "../../core/db.js";
import { logger } from "../../core/logger.js";
import { botClient, botGuild } from "../../core/botClient.js";
import { dmPaused } from "../../services/notify.js";
import { getAutoWarn, setAutoWarn } from "../../services/autoWarn.js";

/**
 * Strictness ladder endpoints for EMS (Phase 4 §8), mounted on /api/v1 behind the
 * Bearer guard. EMS decides everything; the bot only:
 *   POST   /dm                  delivers one DM a person reviewed and sent in EMS
 *   GET|PUT /settings/auto-warn switches its own automatic warnings off per project
 *   POST   /warns, DELETE /warns/:uid  mirrors an EMS formal warning as a Warn row
 *                               (source "ems", status "sent"; the bot sends no DM)
 * Errors: { error: <code>, message, issues? }.
 */
export const ladderRouter = express.Router();
ladderRouter.use(express.json({ limit: "64kb" }));

const discordId = z.string().regex(/^\d{15,25}$/, "must be a Discord id");
const uidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "must be a UUID");

const dmSchema = z.object({ discordUserId: discordId, content: z.string().trim().min(1).max(2000) });
const autoWarnSchema = z.object({
  disabledProjects: z.union([z.literal("all"), z.array(z.string().min(1).max(64)).max(200)]),
});
const warnSchema = z.object({
  uid: uidSchema,
  discordUserId: discordId,
  reason: z.string().trim().min(5).max(1500),
  kind: z.enum(["conduct", "hours", "other"]).default("conduct"),
  issuedBy: z.string().trim().min(2).max(80).optional(),
});
const revokeSchema = z.object({ reason: z.string().trim().min(3).max(1000).optional() });

type Res = express.Response;
const fail = (res: Res, status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
  res.status(status).json({ error, message, ...extra });
const invalid = (res: Res, err: z.ZodError) =>
  fail(res, 400, "invalid", "Request body is invalid.", {
    issues: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`),
  });
const isUniqueClash = (e: unknown) => (e as { code?: string })?.code === "P2002";

/** Discord API error → short reason EMS shows next to "DM failed". */
export function dmFailReason(err: unknown): string {
  const code = (err as { code?: number })?.code;
  if (code === 50007) return "dms_closed"; // Cannot send messages to this user
  if (code === 10013) return "unknown_user";
  if (code === 20026) return "bot_quarantined";
  return String((err as Error)?.message ?? err).slice(0, 200);
}

/** One plain-text DM (no mentions are pinged). No thread fallback: EMS records the failure. */
ladderRouter.post("/dm", async (req, res) => {
  const parsed = dmSchema.safeParse(req.body ?? {});
  if (!parsed.success) return invalid(res, parsed.error);
  const { discordUserId, content } = parsed.data;
  const client = botClient();
  const guild = botGuild(env.DISCORD_GUILD_ID);
  if (!client || !guild) return fail(res, 503, "bot_offline", "The bot is offline; try again later.");
  if (dmPaused()) return fail(res, 422, "dm_failed", "Discord has paused this bot's DMs.", { reason: "dm_paused" });
  const member = await guild.members.fetch(discordUserId).catch(() => null);
  if (!member) return fail(res, 422, "dm_failed", "This person is not in the Discord server.", { reason: "not_in_guild" });
  try {
    await member.send({ content, allowedMentions: { parse: [] } });
  } catch (err) {
    const reason = dmFailReason(err);
    logger.warn({ user: discordUserId, reason }, "EMS DM failed");
    return fail(res, 422, "dm_failed", "The DM could not be delivered.", { reason });
  }
  return res.json({ ok: true });
});

ladderRouter.get("/settings/auto-warn", async (_req, res) => {
  res.json(await getAutoWarn());
});

/** Replace the list. Unknown project keys are stored too (EMS may know a project first) and reported back. */
ladderRouter.put("/settings/auto-warn", async (req, res) => {
  const parsed = autoWarnSchema.safeParse(req.body ?? {});
  if (!parsed.success) return invalid(res, parsed.error);
  const saved = await setAutoWarn(parsed.data);
  const known = new Set(org.projects.map((p) => p.key));
  const unknown = saved.disabledProjects === "all" ? [] : saved.disabledProjects.filter((k) => !known.has(k));
  logger.info({ disabledProjects: saved.disabledProjects }, "Auto-warn switch updated by EMS");
  res.json({ ...saved, unknown });
});

const warnOut = (w: { id: number; externalUid: string | null; status: string }) => ({ id: w.id, uid: w.externalUid, status: w.status });

/** Mirror an EMS formal warning. Same uid again → 200 with the stored row, never a duplicate. */
ladderRouter.post("/warns", async (req, res) => {
  const parsed = warnSchema.safeParse(req.body ?? {});
  if (!parsed.success) return invalid(res, parsed.error);
  const b = parsed.data;
  const existing = await prisma.warn.findUnique({ where: { externalUid: b.uid } });
  if (existing) return res.status(200).json(warnOut(existing));
  try {
    const row = await prisma.warn.create({
      data: {
        guildId: env.DISCORD_GUILD_ID,
        userId: b.discordUserId,
        modId: "ems",
        source: "ems",
        kind: b.kind,
        status: "sent",
        sentAt: new Date(),
        issuedBy: b.issuedBy ?? "EMS strictness ladder",
        reason: b.reason,
        externalUid: b.uid,
      },
    });
    return res.status(201).json(warnOut(row));
  } catch (err) {
    if (!isUniqueClash(err)) throw err;
    const raced = await prisma.warn.findUnique({ where: { externalUid: b.uid } });
    if (raced) return res.status(200).json(warnOut(raced));
    throw err;
  }
});

/** Revoke a mirrored warning (no longer a strike in the bot). Idempotent. */
ladderRouter.delete("/warns/:uid", async (req, res) => {
  const uid = uidSchema.safeParse(req.params.uid);
  if (!uid.success) return fail(res, 400, "invalid", "uid must be a UUID.");
  const parsed = revokeSchema.safeParse(req.body ?? {});
  if (!parsed.success) return invalid(res, parsed.error);
  const w = await prisma.warn.findUnique({ where: { externalUid: uid.data } });
  if (!w) return fail(res, 404, "not_found", "No warning with this uid.");
  if (w.status === "revoked") return res.json(warnOut(w));
  const row = await prisma.warn.update({ where: { id: w.id }, data: { status: "revoked", reviewedBy: "ems" } });
  await prisma.warnNote.create({
    data: { warnId: w.id, author: "EMS", body: parsed.data.reason ?? "Revoked in EMS (strike excused or voided).", kind: "revoke", notified: false },
  });
  return res.json(warnOut(row));
});
