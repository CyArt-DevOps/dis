/**
 * Written analysis for the member report: turns a member's settled days into
 * plain-language findings (trend, weekly breakdown, weekday pattern,
 * punctuality, hours balance, streaks, peer standing). Pure, so the wording
 * rules are unit-tested without a database.
 */

export interface AnalysisDay {
  day: string; // YYYY-MM-DD
  status: string; // good | partial | missing | leave | holiday | off | untracked | future
  seconds: number;
  /** Minutes after local midnight of the first join, if present. */
  firstJoinMin: number | null;
  onTime: boolean;
}

export interface AnalysisInput {
  days: AnalysisDay[]; // settled days only, ascending
  requiredSeconds: number;
  loginByMin: number;
  name: string; // first name for prose
  peers?: { memberRate: number; projectRate: number; projectAvgSeconds: number; percentile: number; project: string; size: number } | null;
}

export interface WeekRow {
  weekOf: string; // Monday
  workdays: number;
  good: number;
  partial: number;
  absent: number;
  leave: number;
  seconds: number;
  rate: number;
}

export interface WeekdayRow {
  weekday: string;
  workdays: number;
  absent: number;
  short: number;
  late: number;
  avgSeconds: number;
}

export interface Analysis {
  weeks: WeekRow[];
  weekdays: WeekdayRow[];
  trend: { firstRate: number; secondRate: number; firstAvg: number; secondAvg: number; direction: "improving" | "declining" | "steady" | "n/a" };
  shortfallSeconds: number;
  surplusSeconds: number;
  bestDay: { day: string; seconds: number } | null;
  longestGood: number;
  longestAbsent: number;
  join: { earliest: number | null; latest: number | null; median: number | null; lateDays: number; avgLateMin: number };
  paragraphs: { title: string; body: string }[];
  conclusion: string;
}

const WD = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const WORK = new Set(["good", "partial", "missing"]);

function hm(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

function clock(min: number): string {
  const m = Math.round(min);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function pct(n: number): string {
  return `${Math.round(n * 10) / 10}%`;
}

function isoWeekday(day: string): number {
  const d = new Date(day + "T00:00:00Z").getUTCDay();
  return d === 0 ? 7 : d;
}

function mondayOf(day: string): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - (isoWeekday(day) - 1));
  return d.toISOString().slice(0, 10);
}

function label(day: string): string {
  return new Date(day + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" });
}

function rateOf(ds: AnalysisDay[]): number {
  const w = ds.filter((d) => WORK.has(d.status));
  return w.length ? (w.filter((d) => d.status === "good").length / w.length) * 100 : 0;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function analyse(input: AnalysisInput): Analysis {
  const { days, requiredSeconds: req, loginByMin, name } = input;
  const work = days.filter((d) => WORK.has(d.status));

  // Weekly breakdown
  const weekMap = new Map<string, WeekRow>();
  for (const d of days) {
    const k = mondayOf(d.day);
    const w = weekMap.get(k) ?? { weekOf: k, workdays: 0, good: 0, partial: 0, absent: 0, leave: 0, seconds: 0, rate: 0 };
    if (WORK.has(d.status)) w.workdays++;
    if (d.status === "good") w.good++;
    if (d.status === "partial") w.partial++;
    if (d.status === "missing") w.absent++;
    if (d.status === "leave") w.leave++;
    w.seconds += d.seconds;
    weekMap.set(k, w);
  }
  const weeks = [...weekMap.values()]
    .filter((w) => w.workdays || w.leave || w.seconds)
    .map((w) => ({ ...w, rate: w.workdays ? (w.good / w.workdays) * 100 : 0 }));

  // Weekday pattern
  const weekdays: WeekdayRow[] = [1, 2, 3, 4, 5].map((n) => {
    const ds = work.filter((d) => isoWeekday(d.day) === n);
    const present = ds.filter((d) => d.status !== "missing");
    return {
      weekday: WD[n - 1]!,
      workdays: ds.length,
      absent: ds.filter((d) => d.status === "missing").length,
      short: ds.filter((d) => d.status === "partial" && d.seconds < req).length,
      late: ds.filter((d) => d.firstJoinMin !== null && !d.onTime).length,
      avgSeconds: present.length ? present.reduce((a, d) => a + d.seconds, 0) / present.length : 0,
    };
  });

  // Trend: first half vs second half of the working days
  const half = Math.floor(work.length / 2);
  const a = work.slice(0, half);
  const b = work.slice(half);
  const avg = (ds: AnalysisDay[]) => (ds.length ? ds.reduce((s, d) => s + d.seconds, 0) / ds.length : 0);
  const firstRate = rateOf(a);
  const secondRate = rateOf(b);
  const direction: Analysis["trend"]["direction"] =
    work.length < 4 ? "n/a" : secondRate - firstRate >= 10 ? "improving" : firstRate - secondRate >= 10 ? "declining" : "steady";

  // Hours balance
  let shortfall = 0;
  let surplus = 0;
  for (const d of work) {
    if (d.seconds < req) shortfall += req - d.seconds;
    else surplus += d.seconds - req;
  }
  const bestDay = days.reduce<{ day: string; seconds: number } | null>(
    (best, d) => (d.seconds > (best?.seconds ?? 0) ? { day: d.day, seconds: d.seconds } : best),
    null
  );

  // Streaks
  let longestGood = 0;
  let longestAbsent = 0;
  let g = 0;
  let ab = 0;
  for (const d of work) {
    g = d.status === "good" ? g + 1 : 0;
    ab = d.status === "missing" ? ab + 1 : 0;
    longestGood = Math.max(longestGood, g);
    longestAbsent = Math.max(longestAbsent, ab);
  }

  // Punctuality
  // A session carried over from the previous night starts the day at 00:00;
  // that isn't a login time, so it's left out of punctuality figures.
  const joins = work
    .map((d) => d.firstJoinMin)
    .filter((x): x is number => x !== null && x > 0)
    .sort((x, y) => x - y);
  const lates = work.filter((d) => d.firstJoinMin !== null && d.firstJoinMin > loginByMin);
  const join = {
    earliest: joins[0] ?? null,
    latest: joins[joins.length - 1] ?? null,
    median: joins.length ? joins[Math.floor(joins.length / 2)]! : null,
    lateDays: lates.length,
    avgLateMin: lates.length ? Math.round(lates.reduce((s, d) => s + (d.firstJoinMin! - loginByMin), 0) / lates.length) : 0,
  };

  // ---------------------------------------------------------------- prose
  const paragraphs: { title: string; body: string }[] = [];

  if (weeks.length) {
    const best = [...weeks].filter((w) => w.workdays).sort((x, y) => y.rate - x.rate || y.seconds - x.seconds)[0];
    const worst = [...weeks].filter((w) => w.workdays).sort((x, y) => x.rate - y.rate || x.seconds - y.seconds)[0];
    let body =
      direction === "n/a"
        ? `There are too few working days in this period to establish a trend.`
        : direction === "improving"
          ? `Attendance improved over the period: compliance rose from ${pct(firstRate)} in the first half to ${pct(secondRate)} in the second, with average daily voice time moving from ${hm(avg(a))} to ${hm(avg(b))}.`
          : direction === "declining"
            ? `Attendance declined over the period: compliance fell from ${pct(firstRate)} in the first half to ${pct(secondRate)} in the second, and average daily voice time moved from ${hm(avg(a))} to ${hm(avg(b))}. This needs attention before it becomes a pattern.`
            : Math.max(firstRate, secondRate) < 25
              ? `Attendance remained poor throughout the period (${pct(firstRate)} compliance in the first half, ${pct(secondRate)} in the second; average ${hm(avg(a))} and ${hm(avg(b))} per working day). There was no sign of improvement.`
              : `Attendance was broadly consistent across the period (${pct(firstRate)} in the first half, ${pct(secondRate)} in the second; average ${hm(avg(a))} and ${hm(avg(b))} per working day).`;
    if (best && worst && best.weekOf !== worst.weekOf && best.rate !== worst.rate) {
      body += ` The strongest week began ${label(best.weekOf)} (${pct(best.rate)} compliance, ${hm(best.seconds)} served); the weakest began ${label(worst.weekOf)} (${pct(worst.rate)}, ${worst.absent} absence${worst.absent === 1 ? "" : "s"}).`;
    }
    paragraphs.push({ title: "Trend over the period", body });
  }

  const problemDays = weekdays.filter((w) => w.workdays >= 2 && w.absent + w.short + w.late >= 2);
  if (work.length) {
    const worstDay = [...weekdays].filter((w) => w.workdays).sort((x, y) => y.absent * 2 + y.short + y.late - (x.absent * 2 + x.short + x.late))[0];
    const strongDay = [...weekdays].filter((w) => w.workdays).sort((x, y) => y.avgSeconds - x.avgSeconds)[0];
    paragraphs.push({
      title: "Weekday pattern",
      body: problemDays.length
        ? `Rule breaks ${problemDays.length >= 5 ? "occur on every weekday" : `cluster on ${list(problemDays.map((w) => w.weekday))}`}. ${worstDay ? `${worstDay.weekday} is the weakest day (${worstDay.absent} absent, ${worstDay.short} short, ${worstDay.late} late out of ${worstDay.workdays}).` : ""} ${strongDay && strongDay.avgSeconds >= 3600 ? `${name} serves the most time on ${strongDay.weekday}s (average ${hm(strongDay.avgSeconds)}).` : ""}`.trim()
        : `No weekday stands out: absences, short days and late logins are not concentrated on any particular day of the week.${strongDay && strongDay.avgSeconds ? ` The longest average sessions are on ${strongDay.weekday}s (${hm(strongDay.avgSeconds)}).` : ""}`,
    });
  }

  if (joins.length) {
    paragraphs.push({
      title: "Punctuality",
      body:
        `${name}'s typical first login was ${clock(join.median!)} (earliest ${clock(join.earliest!)}, latest ${clock(join.latest!)}), against a ${clock(loginByMin)} cutoff. ` +
        (join.lateDays
          ? `${join.lateDays} of ${joins.length} present working day${joins.length === 1 ? " was" : "s were"} late by an average of ${join.avgLateMin} minutes.`
          : `Every present working day started on time.`),
    });
  }

  if (work.length) {
    paragraphs.push({
      title: "Hours balance",
      body:
        `Across ${work.length} working day${work.length === 1 ? "" : "s"} the target was ${hm(req * work.length)}. ` +
        (shortfall
          ? `${name} fell ${hm(shortfall)} short in total on days below target${surplus ? `, and served ${hm(surplus)} above target on other days` : ""}. Extra hours on one day do not offset a short or missed day under the policy.`
          : `${name} met or exceeded the daily target on every working day${surplus ? `, with ${hm(surplus)} served above target in total` : ""}.`) +
        (bestDay && bestDay.seconds ? ` The longest day was ${label(bestDay.day)} at ${hm(bestDay.seconds)}.` : "") +
        (longestGood >= 2 ? ` Longest run of fully compliant working days: ${longestGood}.` : "") +
        (longestAbsent >= 2 ? ` Longest run of consecutive absences: ${longestAbsent}.` : ""),
    });
  }

  if (input.peers && input.peers.size > 1) {
    const pr = input.peers;
    const diff = pr.memberRate - pr.projectRate;
    paragraphs.push({
      title: "Comparison with project peers",
      body:
        `Within ${pr.project} (${pr.size} members), the average compliance for this period was ${pct(pr.projectRate)} and the average member served ${hm(pr.projectAvgSeconds)} per present day. ` +
        `${name}'s compliance of ${pct(pr.memberRate)} is ${Math.abs(diff) < 3 ? "in line with" : `${Math.round(Math.abs(diff))} percentage points ${diff > 0 ? "above" : "below"}`} the project average, placing ${name} ${pr.percentile >= 50 ? "in the top" : "in the bottom"} ${pr.percentile >= 50 ? 100 - pr.percentile + 1 : pr.percentile}% of the project.`,
    });
  }

  // Conclusion
  const overall = rateOf(work);
  const conclusion = !work.length
    ? `No working days fall within this period, so no conclusion on attendance can be drawn.`
    : overall >= 90
      ? `${name}'s attendance in this period meets CyArt's expectations. No corrective action is required; HR recommends acknowledging the consistency shown.`
      : overall >= 75
        ? `${name}'s attendance is good overall but not yet consistent. HR recommends a short check-in to address the specific days and habits noted above, with a review at the end of the next month.`
        : overall >= 50
          ? `${name}'s attendance needs improvement. HR recommends a documented conversation setting clear expectations, with progress reviewed within two weeks. Continued shortfalls will lead to formal warnings under the attendance policy.`
          : `${name}'s attendance is unsatisfactory and does not meet the internship's minimum requirements. HR recommends immediate follow-up; without prompt improvement, formal warnings will be issued and, after three warnings, the internship is terminated under the attendance policy.`;

  return {
    weeks,
    weekdays,
    trend: { firstRate, secondRate, firstAvg: avg(a), secondAvg: avg(b), direction },
    shortfallSeconds: shortfall,
    surplusSeconds: surplus,
    bestDay,
    longestGood,
    longestAbsent,
    join,
    paragraphs,
    conclusion,
  };
}
