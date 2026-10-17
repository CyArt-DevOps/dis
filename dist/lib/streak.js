/**
 * The member's most recent `n` counted working days, if every one of them fell
 * short of the hours target (or was absent) and none is already covered by an
 * earlier hours warning. Pure, so it is unit-tested directly.
 */
export function shortStreak(days, opts) {
    const counted = days.filter((d) => d.day <= opts.settled &&
        (!opts.startsOn || d.day >= opts.startsOn) &&
        (d.status === "good" || d.status === "partial" || d.status === "missing"));
    if (counted.length < opts.n)
        return null;
    const last = counted.slice(-opts.n);
    // The streak must end on the latest settled working day: warn once, promptly.
    const short = (d) => d.status === "missing" || (d.status === "partial" && d.seconds < opts.requiredSeconds);
    if (!last.every(short))
        return null;
    if (last.some((d) => opts.covered.has(d.day)))
        return null;
    return last.map((d) => ({ day: d.day, seconds: d.seconds, absent: d.status === "missing" }));
}
//# sourceMappingURL=streak.js.map