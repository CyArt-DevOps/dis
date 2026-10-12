import { org } from "../config/loader.js";
const TZ = org.timezone; // e.g. "Asia/Kolkata"
/**
 * Constructing an Intl.DateTimeFormat is expensive and these run in hot loops
 * (every voice session is split per day, for every member, for a whole month).
 * Build each formatter once.
 */
const offsetFormatters = new Map();
function offsetFormatter(tz) {
    let f = offsetFormatters.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            hour12: false,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
        offsetFormatters.set(tz, f);
    }
    return f;
}
const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
});
/** Offset (ms) of the zone at a given UTC instant: zoneLocal - utc. */
function zoneOffsetMs(utcMs, tz) {
    const parts = offsetFormatter(tz).formatToParts(new Date(utcMs));
    const map = {};
    for (const p of parts)
        map[p.type] = p.value;
    const asIfUtc = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), Number(map.hour === "24" ? "0" : map.hour), Number(map.minute), Number(map.second));
    return asIfUtc - utcMs;
}
/** Convert wall-clock components in the configured zone to a UTC Date. */
function zonedToUtc(y, mo, d, h, mi) {
    const guess = Date.UTC(y, mo - 1, d, h, mi);
    const offset = zoneOffsetMs(guess, TZ);
    return new Date(guess - offset);
}
/**
 * Parse "DD/MM/YYYY" + "h:mm AM/PM" (configured timezone) into a UTC Date.
 * Returns null if invalid.
 */
export function parseDateTime(dateStr, timeStr) {
    const d = dateStr.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    const t = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
    if (!d || !t)
        return null;
    const day = Number(d[1]);
    const month = Number(d[2]);
    const year = Number(d[3]);
    let hour = Number(t[1]);
    const minute = Number(t[2]);
    const mer = t[3].toUpperCase();
    if (month < 1 || month > 12 || day < 1 || day > 31)
        return null;
    if (hour < 1 || hour > 12 || minute > 59)
        return null;
    if (mer === "PM" && hour !== 12)
        hour += 12;
    if (mer === "AM" && hour === 12)
        hour = 0;
    const utc = zonedToUtc(year, month, day, hour, minute);
    if (Number.isNaN(utc.getTime()))
        return null;
    // Round-trip sanity: reject impossible dates like 31/02
    const back = new Intl.DateTimeFormat("en-CA", {
        timeZone: TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(utc);
    const [by, bm, bd] = back.split("-").map(Number);
    if (by !== year || bm !== month || bd !== day)
        return null;
    return utc;
}
/** Format a UTC Date as a readable string in the configured zone. */
export function formatInTz(date) {
    return new Intl.DateTimeFormat("en-GB", {
        timeZone: TZ,
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
    }).format(date);
}
/** Discord dynamic timestamp (renders in each viewer's local time). */
export function discordTimestamp(date, style = "F") {
    return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}
export function tzName() {
    return TZ;
}
/** YYYY-MM-DD for the given instant in the configured zone. */
export function tzDateKey(d) {
    return dayKeyFormatter.format(d);
}
/** The day key N days before/after the given key (N may be negative). */
export function shiftDayKey(dayKey, days) {
    const [y, m, d] = dayKey.split("-").map(Number);
    const t = Date.UTC(y, m - 1, d) + days * 86400_000;
    return new Date(t).toISOString().slice(0, 10);
}
/**
 * The UTC instant at which a YYYY-MM-DD day STARTS in the configured zone.
 * Used to split a voice session that crosses local midnight into day buckets.
 */
const dayStartCache = new Map();
export function tzDayStartUtc(dayKey) {
    const hit = dayStartCache.get(dayKey);
    if (hit !== undefined)
        return new Date(hit);
    const [y, m, d] = dayKey.split("-").map(Number);
    const start = parseDateTime(`${d}/${m}/${y}`, "12:00 AM") ??
        new Date(Date.parse(`${dayKey}T00:00:00Z`));
    // A day's start instant never changes, and the same handful of days is asked
    // for thousands of times while building a month of calendars.
    if (dayStartCache.size > 4000)
        dayStartCache.clear();
    dayStartCache.set(dayKey, start.getTime());
    return start;
}
/**
 * Split the interval [from, to) into per-day buckets keyed by the LOCAL
 * (configured-zone) calendar day. A session from 23:00 to 01:00 local time
 * therefore credits each day the time actually spent in it, instead of dumping
 * the whole span on the join day (which is what made day totals wrong for
 * anyone connected across midnight).
 */
export function splitByTzDay(from, to) {
    const out = [];
    let cursor = from.getTime();
    const end = to.getTime();
    // Guard: a pathological (corrupt) range can't spin forever.
    for (let i = 0; cursor < end && i < 400; i++) {
        const day = tzDateKey(new Date(cursor));
        const boundary = tzDayStartUtc(shiftDayKey(day, 1)).getTime();
        const stop = Math.min(boundary, end);
        const seconds = Math.round((stop - cursor) / 1000);
        if (seconds > 0)
            out.push({ day, seconds });
        if (stop <= cursor)
            break; // no forward progress — bail rather than loop
        cursor = stop;
    }
    return out;
}
/** Inclusive number of calendar days a leave spans (same day = 1). */
export function inclusiveDaySpan(start, end) {
    const a = Date.parse(tzDateKey(start) + "T00:00:00Z");
    const b = Date.parse(tzDateKey(end) + "T00:00:00Z");
    return Math.floor((b - a) / 86400_000) + 1;
}
/** Current wall-clock parts in the configured zone. */
export function nowParts() {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        hour12: false,
    }).formatToParts(new Date());
    const map = {};
    for (const p of parts)
        map[p.type] = p.value;
    return {
        year: Number(map.year),
        month: Number(map.month),
        day: Number(map.day),
        hour: Number(map.hour === "24" ? "0" : map.hour),
    };
}
/** Range [start, end) for the previous calendar month, as UTC dates. */
export function previousMonthRange() {
    const { year, month } = nowParts();
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const start = parseDateTime(`01/${prevMonth}/${prevYear}`, "12:00 AM");
    const end = parseDateTime(`01/${month}/${year}`, "12:00 AM");
    const label = new Intl.DateTimeFormat("en-GB", {
        timeZone: TZ,
        month: "long",
        year: "numeric",
    }).format(start);
    return { start, end, label };
}
/** Date only, no clock time, in the DD/MM/YYYY form the commands accept. */
export function formatDateInTz(date) {
    return new Intl.DateTimeFormat("en-GB", {
        timeZone: TZ,
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
    }).format(date);
}
/**
 * Human leave duration: a single day collapses to one date, a range shows both
 * ends. The day count is inclusive, matching how leave is actually counted.
 */
export function formatDuration(start, end) {
    const days = inclusiveDaySpan(start, end);
    const unit = days === 1 ? "day" : "days";
    if (tzDateKey(start) === tzDateKey(end))
        return `${formatDateInTz(start)} (1 day)`;
    return `${formatDateInTz(start)} to ${formatDateInTz(end)} (${days} ${unit})`;
}
//# sourceMappingURL=time.js.map