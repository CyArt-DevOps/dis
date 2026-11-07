import { shiftDayKey, tzDateKey, tzDayStartUtc } from "./time.js";
/**
 * Half-day leave (EMS spec 2026-11-07 §7): one date and a 3 h window inside
 * 11:30–19:00 IST, stored on the leave row as halfDay / halfStart / halfEnd
 * ("HH:MM"). The member is NOT off for the day: only the window is excused.
 * Same rules as EMS's services/halfDayLeave.js.
 */
export const HALF_DAY_OPEN = "11:30";
export const HALF_DAY_CLOSE = "19:00";
export const HALF_DAY_MINUTES = 180;
/** "HH:MM" (or "HH:MM:SS") → minutes since midnight, else null. */
export function toMinutes(v) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(typeof v === "string" ? v.trim() : "");
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
export const toHhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
/** Start times an intern may pick: 11:30 to 16:00 in 30-minute steps (so the end is never after 19:00). */
export const HALF_DAY_STARTS = (() => {
    const out = [];
    for (let m = toMinutes(HALF_DAY_OPEN); m + HALF_DAY_MINUTES <= toMinutes(HALF_DAY_CLOSE); m += 30)
        out.push(toHhmm(m));
    return out;
})();
/** Window end for a start time (start + 3 h), else null. */
export function halfDayEnd(start) {
    const s = toMinutes(start);
    return s === null ? null : toHhmm(s + HALF_DAY_MINUTES);
}
/** Why this window is not a valid half day, or null when it is. */
export function halfWindowError(start, end) {
    const s = toMinutes(start);
    const e = toMinutes(end);
    if (s === null || e === null)
        return "A half day needs a start and end time (HH:MM).";
    if (s < toMinutes(HALF_DAY_OPEN))
        return `A half day cannot start before ${HALF_DAY_OPEN}.`;
    if (e > toMinutes(HALF_DAY_CLOSE))
        return `A half day cannot end after ${HALF_DAY_CLOSE}.`;
    if (e - s !== HALF_DAY_MINUTES)
        return "A half day must be exactly 3 hours.";
    return null;
}
export const halfDayLabel = (start, end) => `Half-day leave ${start}–${end}`;
/** The window of a half-day leave row, else null (a full-day leave). */
export function halfWindowOf(row) {
    return row.halfDay && row.halfStart && row.halfEnd ? { start: row.halfStart, end: row.halfEnd } : null;
}
/** "Half-day leave 13:00–16:00" for a half day, else the type's own label. */
export function leaveLabel(row, typeLabel) {
    const w = halfWindowOf(row);
    return w ? halfDayLabel(w.start, w.end) : typeLabel;
}
/** "HH:MM" on an IST day → UTC instant. */
export function localTimeOn(day, hhmm) {
    return new Date(tzDayStartUtc(day).getTime() + (toMinutes(hhmm) ?? 0) * 60_000);
}
/** The window as UTC instants. */
export function halfWindowUtc(day, start, end) {
    return { start: localTimeOn(day, start), end: localTimeOn(day, end) };
}
/** IST days a leave row lists: its exact approved days, else every day of its range. */
function coveredDays(row) {
    const exact = (row.approvedDays ?? "").split(",").filter(Boolean);
    if (exact.length)
        return exact;
    const out = [];
    for (let d = tzDateKey(row.startAt); d <= tzDateKey(row.endAt); d = shiftDayKey(d, 1))
        out.push(d);
    return out;
}
/**
 * Does an (approved) leave excuse this instant? A full-day leave covers its
 * calendar days; a half day covers only [start, end) of its window.
 */
export function leaveCoversAt(row, at) {
    const day = tzDateKey(at);
    if (!coveredDays(row).includes(day))
        return false;
    const w = halfWindowOf(row);
    if (!w)
        return true;
    const { start, end } = halfWindowUtc(day, w.start, w.end);
    return at >= start && at < end;
}
/**
 * A day's attendance rules with an approved half day (same as the EMS close):
 * the hours target drops by 3 h, and when the window starts at or before the
 * join cutoff the cutoff moves to the window end.
 */
export function halfDayRules(policy, half) {
    const requiredSeconds = Math.max(0, Math.round(policy.minHours * 3600) - HALF_DAY_MINUTES * 60);
    const s = toMinutes(half.start);
    const cut = toMinutes(policy.loginBy);
    const loginBy = s !== null && cut !== null && s <= cut ? half.end : policy.loginBy;
    return { requiredSeconds, loginBy };
}
//# sourceMappingURL=halfDay.js.map