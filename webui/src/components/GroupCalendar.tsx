import { hm, timeOf, type MemberCalendar } from "../api";
import { navigate } from "../lib/router";
import { DAY_STATUS } from "./status";

/**
 * Members down the side, days across the top — the batch/project/module/pod
 * view. Names are the only text; everything else is colour, which is what makes
 * a 200-row group readable. Clicking a name opens that member's profile.
 */
export function GroupCalendar({ members }: { members: MemberCalendar[] }) {
  if (members.length === 0) {
    return <p className="p-6 text-sm text-muted-foreground">No members match these filters.</p>;
  }
  const days = members[0]!.days;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-surface px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Member
            </th>
            {days.map((d) => (
              <th
                key={d.day}
                className="px-0.5 py-2 text-center text-[10px] font-normal text-muted-foreground"
              >
                {Number(d.day.slice(-2))}
              </th>
            ))}
            <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">
              G/P/M
            </th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.userId} className="group">
              <td className="sticky left-0 z-10 max-w-[15rem] truncate bg-surface py-1 pr-3 pl-3 group-hover:bg-content2">
                <button
                  type="button"
                  onClick={() => navigate(`/member/${encodeURIComponent(m.userId)}`)}
                  className="truncate text-left font-medium text-foreground hover:text-indigo-400 hover:underline"
                  title={`${m.fullName} — open profile`}
                >
                  {m.fullName}
                </button>
              </td>
              {m.days.map((d) => (
                <td key={d.day} className="px-0.5 py-1">
                  <div
                    title={`${m.fullName} · ${d.day} — ${DAY_STATUS[d.status].label}${
                      d.seconds > 0
                        ? ` · in ${timeOf(d.firstJoinAt)} · ${hm(d.seconds)}`
                        : ""
                    }`}
                    className={`mx-auto h-5 w-5 rounded ${DAY_STATUS[d.status].cell}`}
                  />
                </td>
              ))}
              <td className="whitespace-nowrap py-1 pr-3 pl-3 text-right text-xs tabular-nums text-muted-foreground">
                <span className="text-emerald-400">{m.totals.good}</span>
                {" / "}
                <span className="text-amber-400">{m.totals.partial}</span>
                {" / "}
                <span className="text-rose-400">{m.totals.missing}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
