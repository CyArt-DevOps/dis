/** Day statuses as produced by services/calendar (kept structural to stay pure). */
interface StreakDay {
  day: string;
  status: string;
  seconds: number;
  /** Set on a half-day leave day: that day's lower target (overrides opts.requiredSeconds). */
  requiredSeconds?: number;
}

/**
 * The member's most recent `n` counted working days, if every one of them fell
 * short of the hours target (or was absent) and none is already covered by an
 * earlier hours warning. Pure, so it is unit-tested directly.
 */
export function shortStreak(
  days: StreakDay[],
  opts: { settled: string; n: number; requiredSeconds: number; covered: Set<string>; startsOn?: string }
): { day: string; seconds: number; absent: boolean; requiredSeconds: number }[] | null {
  const counted = days.filter(
    (d) =>
      d.day <= opts.settled &&
      (!opts.startsOn || d.day >= opts.startsOn) &&
      (d.status === "good" || d.status === "partial" || d.status === "missing")
  );
  if (counted.length < opts.n) return null;
  const last = counted.slice(-opts.n);
  // The streak must end on the latest settled working day: warn once, promptly.
  const short = (d: (typeof last)[number]) =>
    d.status === "missing" || (d.status === "partial" && d.seconds < (d.requiredSeconds ?? opts.requiredSeconds));
  if (!last.every(short)) return null;
  if (last.some((d) => opts.covered.has(d.day))) return null;
  return last.map((d) => ({
    day: d.day, seconds: d.seconds, absent: d.status === "missing", requiredSeconds: d.requiredSeconds ?? opts.requiredSeconds,
  }));
}

