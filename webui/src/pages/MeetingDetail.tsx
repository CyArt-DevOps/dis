import { useMemo, useState } from "react";
import { get, type MeetingDetail } from "../api";
import { useAsync } from "../lib/useAsync";
import { navigate } from "../lib/router";
import { Donut } from "../components/charts";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  PageHeader,
  Segmented,
  Skeleton,
  Stat,
  StatStrip,
  cx,
  rateTone,
  type Tone,
} from "../components/ui";

type Filter = "all" | "present" | "late" | "left_early" | "absent" | "excused";

const STATUS: Record<string, { label: string; tone: Tone; order: number }> = {
  present: { label: "On time", tone: "good", order: 0 },
  late: { label: "Late", tone: "warn", order: 1 },
  left_early: { label: "Left early", tone: "warn", order: 2 },
  absent: { label: "Absent", tone: "bad", order: 3 },
  excused: { label: "Excused (leave)", tone: "info", order: 4 },
};

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function MeetingDetailPage({ id }: { id: number }) {
  const { data, error, loading } = useAsync(() => get<MeetingDetail>(`/api/meetings/${id}`), [id]);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");

  const counts = useMemo(() => {
    const c = { present: 0, late: 0, left_early: 0, absent: 0, excused: 0 };
    for (const a of data?.attendees ?? []) if (a.status in c) c[a.status as keyof typeof c]++;
    return c;
  }, [data]);

  if (error) return <ErrorNote message={error} />;
  if (loading && !data) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 w-2/3" />
        <Skeleton className="h-28" />
        <Skeleton className="h-96" />
      </div>
    );
  }
  if (!data) return <Empty>Meeting not found.</Empty>;

  const m = data.meeting;
  const start = new Date(m.startAt);
  // Left early = joined but under 70 % of the meeting: attended, shown separately.
  const attended = counts.present + counts.late + counts.left_early;
  const expected = attended + counts.absent;
  const pct = expected ? Math.round((attended / expected) * 1000) / 10 : 0;
  const lateRows = data.attendees.filter((a) => a.status === "late");
  const avgLate = lateRows.length ? Math.round(lateRows.reduce((s, a) => s + a.minutesLate, 0) / lateRows.length) : 0;
  const audience =
    m.audienceType === "org"
      ? "Whole organization"
      : [m.audienceBatch, m.audienceProject, m.audienceModule ? `Module ${m.audienceModule}` : null, m.audiencePod ? `Pod ${m.audiencePod}` : null]
          .filter(Boolean)
          .join(" · ") || m.audienceType;

  const rows = data.attendees
    .filter((a) => filter === "all" || a.status === filter)
    .filter((a) => !q || (a.fullName ?? a.userId).toLowerCase().includes(q.toLowerCase()))
    .sort(
      (a, b) =>
        (STATUS[a.status]?.order ?? 9) - (STATUS[b.status]?.order ?? 9) ||
        (a.actualJoinAt ?? "~").localeCompare(b.actualJoinAt ?? "~") ||
        (a.fullName ?? "").localeCompare(b.fullName ?? "")
    );

  return (
    <div className="space-y-6">
      <Button size="sm" variant="ghost" onClick={() => (history.length > 1 ? history.back() : navigate("/meetings"))}>
        ← All meetings
      </Button>

      <PageHeader
        eyebrow={
          <>
            <Badge tone={m.status === "completed" ? "neutral" : m.status === "cancelled" ? "bad" : "info"}>{m.status}</Badge>
            {m.mandatory ? "Mandatory" : "Optional"} · #{m.id}
          </>
        }
        title={m.title}
        description={`${start.toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })} · ${m.durationMin} min · ${audience} · organised by ${m.organizerName} · late after ${m.attendanceWindowMin} min`}
      />
      {m.description ? <p className="max-w-3xl text-sm text-muted">{m.description}</p> : null}

      <StatStrip cols={5}>
        <Stat label="Attendance" value={`${pct}%`} tone={expected ? rateTone(pct) : undefined} hint={`${attended} of ${expected} expected${counts.left_early ? ` · ${counts.left_early} left early` : ""}`} />
        <Stat label="Joined on time" value={counts.present} tone="good" />
        <Stat label="Joined late" value={counts.late} tone={counts.late ? "warn" : undefined} hint={counts.late ? `avg ${avgLate} min late` : " "} />
        <Stat label="Absent" value={counts.absent} tone={counts.absent ? "bad" : undefined} hint="never joined" />
        <Stat label="Excused" value={counts.excused} tone="info" hint="approved leave" />
      </StatStrip>

      <div className="grid gap-4 xl:grid-cols-4">
        <Card className="min-w-0">
          <CardHeader title="Breakdown" />
          <div className="flex flex-col items-center gap-5 p-5">
            <Donut
              segments={[
                { label: "On time", value: counts.present, color: "#34d399" },
                { label: "Late", value: counts.late, color: "#fbbf24" },
                { label: "Left early", value: counts.left_early, color: "#fb923c" },
                { label: "Absent", value: counts.absent, color: "#fb7185" },
                { label: "Excused", value: counts.excused, color: "#a5b4fc" },
              ]}
              center={`${pct}%`}
              sub="attended"
            />
            {lateRows.length ? (
              <div className="w-full">
                <div className="mb-2 text-xs font-medium text-muted">Latest arrivals</div>
                <ul className="space-y-1.5 text-sm">
                  {[...lateRows]
                    .sort((a, b) => b.minutesLate - a.minutesLate)
                    .slice(0, 5)
                    .map((a) => (
                      <li key={a.userId} className="flex justify-between gap-2">
                        <span className="truncate">{a.fullName ?? a.userId}</span>
                        <span className="shrink-0 tabular-nums text-amber-300">+{a.minutesLate}m</span>
                      </li>
                    ))}
                </ul>
              </div>
            ) : null}
          </div>
        </Card>

        <Card className="min-w-0 overflow-hidden xl:col-span-3">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: `All ${data.attendees.length}` },
                { value: "present", label: `On time ${counts.present}` },
                { value: "late", label: `Late ${counts.late}` },
                { value: "left_early", label: `Left early ${counts.left_early}` },
                { value: "absent", label: `Absent ${counts.absent}` },
                { value: "excused", label: `Excused ${counts.excused}` },
              ]}
            />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find a member…"
              className="h-8 w-full rounded-full border border-line-strong bg-panel px-3.5 text-sm outline-none placeholder:text-dim sm:w-56"
            />
          </div>
          <div className="scroll-thin max-h-[65vh] overflow-auto">
            {rows.length === 0 ? (
              <Empty>No one in this group.</Empty>
            ) : (
              <table className="w-full min-w-[640px] text-sm">
                <thead className="sticky top-0 z-10 bg-panel">
                  <tr className="border-b border-line text-left text-[11px] tracking-[0.06em] text-dim uppercase">
                    <th className="px-5 py-2.5 font-medium">Member</th>
                    <th className="px-3 py-2.5 font-medium">Status</th>
                    <th className="px-3 py-2.5 font-medium">Joined at</th>
                    <th className="px-3 py-2.5 text-right font-medium">Late by</th>
                    <th className="px-5 py-2.5 font-medium">M / P</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => {
                    const s = STATUS[a.status] ?? { label: a.status, tone: "neutral" as Tone };
                    return (
                      <tr
                        key={a.userId}
                        onClick={() => navigate(`/member/${encodeURIComponent(a.userId)}`)}
                        className="cursor-pointer border-b border-line/60 transition-colors last:border-0 hover:bg-white/[0.03]"
                      >
                        <td className="px-5 py-2.5">
                          <div className="flex items-center gap-2.5">
                            <Avatar name={a.fullName ?? a.userId} size={28} />
                            <div className="min-w-0">
                              <div className="truncate font-medium">{a.fullName ?? a.userId}</div>
                              <div className="truncate text-xs text-dim">{[a.project, a.batch].filter(Boolean).join(" · ")}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3">
                          <Badge tone={s.tone} dot>
                            {s.label}
                          </Badge>
                        </td>
                        <td className={cx("px-3 tabular-nums", a.actualJoinAt ? "" : "text-dim")}>
                          {a.actualJoinAt ? clock(a.actualJoinAt) : "—"}
                        </td>
                        <td className={cx("px-3 text-right tabular-nums", a.minutesLate ? "text-amber-300" : "text-dim")}>
                          {a.minutesLate ? `${a.minutesLate} min` : "—"}
                        </td>
                        <td className="px-5 whitespace-nowrap tabular-nums text-muted">
                          {a.module ?? "–"} / {a.pod ?? "–"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
