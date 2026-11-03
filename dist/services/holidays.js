import { prisma } from "../core/db.js";
import { org } from "../config/loader.js";
/**
 * Public holidays: org-wide non-working days. Every consumer (calendar,
 * compliance, insights, warnings) treats a holiday exactly like a weekend, so
 * nobody is marked absent or warned for it.
 */
const TTL_MS = 60_000;
const cache = new Map();
/** day (YYYY-MM-DD) → holiday name, for one guild. Cached for a minute. */
export async function holidayMap(guildId) {
    const hit = cache.get(guildId);
    if (hit && Date.now() - hit.at < TTL_MS)
        return hit.value;
    const rows = await prisma.holiday.findMany({ where: { guildId }, select: { day: true, name: true } });
    const value = new Map(rows.map((r) => [r.day, r.name]));
    cache.set(guildId, { at: Date.now(), value });
    return value;
}
export function clearHolidayCache() {
    cache.clear();
}
/** ISO weekday 1 (Mon) … 7 (Sun) for a YYYY-MM-DD key. */
export function isoWeekday(day) {
    const d = new Date(day + "T00:00:00Z").getUTCDay();
    return d === 0 ? 7 : d;
}
/** A working day per policy, and not a holiday. */
export function isWorkingDay(day, holidays) {
    return org.attendancePolicy.workdays.includes(isoWeekday(day)) && !holidays.has(day);
}
export class HolidayInputError extends Error {
}
/** YYYY-MM-DD that exists on the calendar (Date.parse alone lets 2027-02-31 through). */
export function isRealDay(v) {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v))
        return false;
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
export async function listHolidays(guildId) {
    return prisma.holiday.findMany({ where: { guildId }, orderBy: { day: "asc" } });
}
export async function addHoliday(guildId, input) {
    const day = String(input.day ?? "");
    if (!isRealDay(day)) {
        throw new HolidayInputError("Pick a valid date.");
    }
    const name = String(input.name ?? "").trim();
    // Same limits as EMS, or a date with a short EMS name could never sync here.
    if (name.length < 1 || name.length > 120)
        throw new HolidayInputError("Name must be 1–120 characters.");
    const addedBy = String(input.addedBy ?? "").trim().slice(0, 80) || null;
    const exists = await prisma.holiday.findUnique({ where: { guildId_day: { guildId, day } } });
    if (exists)
        throw new HolidayInputError(`${day} is already a holiday (${exists.name}).`);
    const row = await prisma.holiday.create({ data: { guildId, day, name, addedBy } });
    clearHolidayCache();
    return row;
}
export async function removeHoliday(guildId, id) {
    const row = await prisma.holiday.findUnique({ where: { id } });
    if (!row || row.guildId !== guildId)
        throw new HolidayInputError("Holiday not found.");
    await prisma.holiday.delete({ where: { id } });
    clearHolidayCache();
}
/** Remove a date if present. Used by the EMS sync, where "already gone" is success. */
export async function removeHolidayByDay(guildId, day) {
    await prisma.holiday.deleteMany({ where: { guildId, day } });
    clearHolidayCache();
}
//# sourceMappingURL=holidays.js.map