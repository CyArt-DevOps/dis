import { get, type MeetingRow } from "../api";
import { useAsync } from "../lib/useAsync";
import { navigate } from "../lib/router";
import { Badge, Card, Empty, ErrorNote, Meter, PageHeader, Skeleton, Stat, StatStrip, rateTone, type Tone } from "../components/ui";

const STATUS_TONE: Record<string, Tone> = {
  completed: "neutral",
  monitoring: "good",
  scheduled: "info",
  cancelled: "bad",
};

export function MeetingsPage() {
  const { data, error, loading } = useAsync(() => get<MeetingRow[]>("/api/meetings"), []);
  const rows = (data ?? []).map((m) => {
    const present = m.counts.present ?? 0;
    const late = m.counts.late ?? 0;
    const leftEarly = m.counts.left_early ?? 0; // attended but under 70 %: counts toward attendance
    const absent = m.counts.absent ?? 0;
    const excused = m.counts.excused ?? 0;
    const attended = present + late + leftEarly;
    const expected = attended + absent;
    return { ...m, present, late, leftEarly, absent, excused, attended, expected, pct: expected ? Math.round((attended / expected) * 1000) / 10 : 0 };
  });
  const held = rows.filter((r) => r.expected > 0);
  const sum = held.reduce((a, r) => ({ p: a.p + r.attended, e: a.e + r.expected, l: a.l + r.late, ab: a.ab + r.absent }), { p: 0, e: 0, l: 0, ab: 0 });
  const avg = sum.e ? Math.round((sum.p / sum.e) * 1000) / 10 : 0;
  const upcoming = rows.filter((r) => r.status === "scheduled").length;

  return (
    <div className="space-y-6">
      <PageHeader title="Meetings" description="Last 50 meetings. Click one to see who joined, when, and who was late. Attendance = present + late over everyone expected." />
      {error ? <ErrorNote message={error} /> : null}

      <StatStrip cols={4}>
        <Stat label="Avg attendance" value={`${avg}%`} tone={held.length ? rateTone(avg) : undefined} hint={`${held.length} meetings with records`} />
        <Stat label="No-shows" value={sum.ab.toLocaleString()} tone={sum.ab ? "bad" : undefined} hint="absent without leave" />
        <Stat label="Late arrivals" value={sum.l.toLocaleString()} tone={sum.l ? "warn" : undefined} />
        <Stat label="Upcoming" value={upcoming} tone="info" hint="scheduled" />
      </StatStrip>

      <Card className="overflow-hidden">
        <div className="scroll-thin max-h-[72vh] overflow-auto">
          {loading && !data ? (
            <div className="space-y-2 p-5">
              {Array.from({ length: 8 }, (_, k) => (
                <Skeleton key={k} className="h-10" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <Empty>No meetings yet.</Empty>
          ) : (
            <table className="w-full min-w-[820px] text-sm">
              <thead className="sticky top-0 z-10 bg-panel">
                <tr className="border-b border-line text-left text-[11px] tracking-[0.06em] text-dim uppercase">
                  <th className="px-5 py-2.5 font-medium">Meeting</th>
                  <th className="px-3 py-2.5 font-medium">When</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="w-[24%] px-3 py-2.5 font-medium">Attendance</th>
                  <th className="px-3 py-2.5 text-right font-medium">On time</th>
                  <th className="px-3 py-2.5 text-right font-medium">Late</th>
                  <th className="px-3 py-2.5 text-right font-medium">Left early</th>
                  <th className="px-3 py-2.5 text-right font-medium">Absent</th>
                  <th className="px-5 py-2.5 text-right font-medium">Excused</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr
                    key={m.id}
                    onClick={() => navigate(`/meetings/${m.id}`)}
                    className="cursor-pointer border-b border-line/60 transition-colors last:border-0 hover:bg-white/[0.03]"
                  >
                    <td className="px-5 py-3">
                      <div className="font-medium">{m.title}</div>
                      <div className="text-xs text-dim">
                        #{m.id} · {m.durationMin} min
                      </div>
                    </td>
                    <td className="px-3 tabular-nums text-muted">
                      {new Date(m.startAt).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </td>
                    <td className="px-3">
                      <Badge tone={STATUS_TONE[m.status] ?? "neutral"}>{m.status}</Badge>
                    </td>
                    <td className="px-3">
                      {m.expected ? (
                        <div className="flex items-center gap-2.5">
                          <div className="flex-1">
                            <Meter value={m.pct} tone={rateTone(m.pct)} />
                          </div>
                          <span className="w-12 text-right text-xs tabular-nums">{m.pct}%</span>
                        </div>
                      ) : (
                        <span className="text-xs text-dim">—</span>
                      )}
                    </td>
                    <td className="px-3 text-right tabular-nums text-emerald-300">{m.present}</td>
                    <td className="px-3 text-right tabular-nums text-amber-300">{m.late}</td>
                    <td className="px-3 text-right tabular-nums text-orange-300">{m.leftEarly}</td>
                    <td className="px-3 text-right tabular-nums text-rose-300">{m.absent}</td>
                    <td className="px-5 text-right tabular-nums text-dim">{m.excused}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  );
}
