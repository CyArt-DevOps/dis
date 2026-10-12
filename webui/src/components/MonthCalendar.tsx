import { hm, timeOf, type CalendarDay } from "../api";
import { DAY_STATUS } from "./status";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Monday-first column index (0-6) for a YYYY-MM-DD key. */
function columnOf(day: string): number {
  const d = new Date(day + "T00:00:00Z").getUTCDay(); // 0 = Sun
  return (d + 6) % 7;
}

/**
 * A real month grid (not a strip), so a member's pattern — late Mondays, missed
 * Fridays — is visible at a glance.
 */
export function MonthCalendar({ days }: { days: CalendarDay[] }) {
  if (days.length === 0) return <p className="text-sm text-muted-foreground">No days in range.</p>;
  const lead = columnOf(days[0]!.day);

  return (
    <div>
      <div className="grid grid-cols-7 gap-1.5">
        {WEEKDAYS.map((w) => (
          <div key={w} className="pb-1 text-center text-xs font-medium text-muted-foreground">
            {w}
          </div>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <div key={`pad-${i}`} />
        ))}
        {days.map((d) => {
          const s = DAY_STATUS[d.status];
          const num = Number(d.day.slice(-2));
          const detail =
            d.status === "leave"
              ? "approved leave"
              : d.status === "off"
                ? "non-working day"
                : d.status === "future"
                  ? "upcoming"
                  : d.firstJoinAt
                    ? `in ${timeOf(d.firstJoinAt)}${d.onTime ? "" : " (late)"} · ${hm(d.seconds)}`
                    : "no voice activity";
          return (
            <div
              key={d.day}
              title={`${d.day} — ${s.label}: ${detail}`}
              className={`flex aspect-square flex-col items-center justify-center rounded-lg text-sm font-medium transition-colors ${s.cell}`}
            >
              <span>{num}</span>
              {d.seconds > 0 ? (
                <span className="text-[10px] font-normal opacity-80">
                  {Math.floor(d.seconds / 3600)}h
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
