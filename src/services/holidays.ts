import { prisma } from "../core/db.js";
import { org } from "../config/loader.js";

/**
 * Public holidays: org-wide non-working days. Every consumer (calendar,
 * compliance, insights, warnings) treats a holiday exactly like a weekend, so
 * nobody is marked absent or warned for it.
 */

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: Map<string, string> }>();

/** day (YYYY-MM-DD) → holiday name, for one guild. Cached for a minute. */
export async function holidayMap(guildId: string): Promise<Map<string, string>> {
  const hit = cache.get(guildId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const rows = await prisma.holiday.findMany({ where: { guildId }, select: { day: true, name: true } });
  const value = new Map(rows.map((r) => [r.day, r.name]));
  cache.set(guildId, { at: Date.now(), value });
  return value;
}

export function clearHolidayCache(): void {
  cache.clear();
}

/** ISO weekday 1 (Mon) … 7 (Sun) for a YYYY-MM-DD key. */
export function isoWeekday(day: string): number {
  const d = new Date(day + "T00:00:00Z").getUTCDay();
  return d === 0 ? 7 : d;
}

/** A working day per policy, and not a holiday. */
export function isWorkingDay(day: string, holidays: Map<string, string>): boolean {
  return org.attendancePolicy.workdays.includes(isoWeekday(day)) && !holidays.has(day);
}

export class HolidayInputError extends Error {}

export async function listHolidays(guildId: string) {
  return prisma.holiday.findMany({ where: { guildId }, orderBy: { day: "asc" } });
}

export async function addHoliday(guildId: string, input: { day?: unknown; name?: unknown; addedBy?: unknown }) {
  const day = String(input.day ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day + "T00:00:00Z"))) {
    throw new HolidayInputError("Pick a valid date.");
  }
  const name = String(input.name ?? "").trim();
  if (name.length < 2 || name.length > 120) throw new HolidayInputError("Name must be 2–120 characters.");
  const addedBy = String(input.addedBy ?? "").trim().slice(0, 80) || null;
  const exists = await prisma.holiday.findUnique({ where: { guildId_day: { guildId, day } } });
  if (exists) throw new HolidayInputError(`${day} is already a holiday (${exists.name}).`);
  const row = await prisma.holiday.create({ data: { guildId, day, name, addedBy } });
  clearHolidayCache();
  return row;
}

export async function removeHoliday(guildId: string, id: number): Promise<void> {
  const row = await prisma.holiday.findUnique({ where: { id } });
  if (!row || row.guildId !== guildId) throw new HolidayInputError("Holiday not found.");
  await prisma.holiday.delete({ where: { id } });
  clearHolidayCache();
}
