import { splitByTzDay } from "./time.js";
/**
 * The seconds one member really spent in voice, per local day, from their
 * session times alone. An open session counts only up to its checkpoint, the
 * same point Attendance has been credited to, so the sweep can carry on from
 * there. Each session stops at `capSeconds`, as live crediting does, and spans
 * that overlap are counted once.
 */
export function realSecondsByDay(sessions, capSeconds) {
    const spans = [];
    for (const s of sessions) {
        const start = s.joinedAt.getTime();
        const stop = (s.leftAt ?? s.creditedUpTo ?? s.joinedAt).getTime();
        const end = Math.min(stop, start + capSeconds * 1000);
        if (end > start)
            spans.push([start, end]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [start, end] of spans) {
        const last = merged[merged.length - 1];
        if (last && start <= last[1])
            last[1] = Math.max(last[1], end);
        else
            merged.push([start, end]);
    }
    const out = new Map();
    for (const [start, end] of merged) {
        for (const b of splitByTzDay(new Date(start), new Date(end))) {
            out.set(b.day, (out.get(b.day) ?? 0) + b.seconds);
        }
    }
    return out;
}
//# sourceMappingURL=voiceHours.js.map