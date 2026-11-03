import express from "express";
import { env } from "../../config/env.js";
import { prisma } from "../../core/db.js";
import { HolidayInputError, addHoliday, isRealDay, removeHolidayByDay } from "../../services/holidays.js";
/**
 * Holiday sync with EMS (spec 2026-11-03 §6), mounted at /api/v1/holidays behind the v1 Bearer guard. EMS holds the
 * merge logic and calls these. They touch only the database, so they work while the bot is offline.
 *   GET    /?from=YYYY-MM-DD  → 200 [{ day, name }]
 *   POST   /  { day, name }   → 201 { day, name } | 200 existing row | 400 invalid
 *   DELETE /:day              → 204, including when already gone
 */
export const holidaysRouter = express.Router();
holidaysRouter.use(express.json({ limit: "8kb" }));
holidaysRouter.get("/", async (req, res) => {
    const { from } = req.query;
    if (!isRealDay(from)) {
        res.status(400).json({ error: "invalid", message: "from (YYYY-MM-DD) is required." });
        return;
    }
    const rows = await prisma.holiday.findMany({
        where: { guildId: env.DISCORD_GUILD_ID, day: { gte: from } },
        orderBy: { day: "asc" },
    });
    res.json(rows.map((r) => ({ day: r.day, name: r.name })));
});
holidaysRouter.post("/", async (req, res) => {
    const { day, name } = (req.body ?? {});
    if (!isRealDay(day)) {
        res.status(400).json({ error: "invalid", message: "day (YYYY-MM-DD) is required." });
        return;
    }
    const existing = await prisma.holiday.findUnique({ where: { guildId_day: { guildId: env.DISCORD_GUILD_ID, day } } });
    if (existing) {
        res.status(200).json({ day: existing.day, name: existing.name });
        return;
    }
    try {
        const row = await addHoliday(env.DISCORD_GUILD_ID, { day, name, addedBy: "EMS sync" });
        res.status(201).json({ day: row.day, name: row.name });
    }
    catch (err) {
        if (err instanceof HolidayInputError) {
            res.status(400).json({ error: "invalid", message: err.message });
            return;
        }
        throw err;
    }
});
holidaysRouter.delete("/:day", async (req, res) => {
    if (!isRealDay(req.params.day)) {
        res.status(400).json({ error: "invalid", message: "day must be YYYY-MM-DD." });
        return;
    }
    await removeHolidayByDay(env.DISCORD_GUILD_ID, req.params.day);
    res.status(204).end();
});
//# sourceMappingURL=holidays.js.map