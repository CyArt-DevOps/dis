import { Button, Card, Chip } from "@heroui/react";
import { ago, get, hm, monthLabel, shiftMonth, type Profile } from "../api";
import { useAsync } from "../lib/useAsync";
import { navigate } from "../lib/router";
import { MonthCalendar } from "../components/MonthCalendar";
import { Legend } from "../components/status";
import { StatCard, StatGrid } from "../components/StatCard";

const MEETING_COLOR: Record<string, "success" | "warning" | "danger" | "default"> = {
  present: "success",
  late: "warning",
  absent: "danger",
  excused: "default",
};

export function ProfilePage({
  userId,
  month,
  onMonth,
  minMonth,
}: {
  userId: string;
  month: string;
  onMonth: (m: string) => void;
  minMonth: string | null;
}) {
  const atStart = Boolean(minMonth && month <= minMonth);
  const { data, error, loading } = useAsync(
    () => get<Profile>(`/api/profile/${encodeURIComponent(userId)}?month=${month}`),
    [userId, month]
  );

  if (error) return <p className="text-sm text-rose-400">Error: {error}</p>;
  if (loading && !data) return <p className="text-sm text-muted-foreground">Loading profile…</p>;
  if (!data?.member) return <p className="text-sm text-muted-foreground">Member not found.</p>;

  const m = data.member;
  const cal = data.calendar;
  const monthSeconds = cal?.days.reduce((a, d) => a + d.seconds, 0) ?? 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Button size="sm" variant="ghost" onPress={() => navigate("/calendar")}>
            ← Back
          </Button>
          <h2 className="mt-2 flex items-center gap-2 text-xl font-semibold">
            {m.fullName}
            {data.live ? (
              <Chip color="success" size="sm" variant="soft">
                in voice now
              </Chip>
            ) : null}
          </h2>
          <p className="text-sm text-muted-foreground">
            {[m.project, m.batch, m.module ? `Module ${m.module}` : null, m.pod ? `Pod ${m.pod}` : null]
              .filter(Boolean)
              .join(" · ") || "No project assigned"}
            {m.tag ? ` · @${m.tag}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            isDisabled={atStart}
            onPress={() => onMonth(shiftMonth(month, -1))}
          >
            ← Prev
          </Button>
          <span className="min-w-[9rem] text-center text-sm font-medium">{monthLabel(month)}</span>
          <Button size="sm" variant="ghost" onPress={() => onMonth(shiftMonth(month, 1))}>
            Next →
          </Button>
        </div>
      </div>

      <StatGrid>
        <StatCard label="Completed" value={cal?.totals.good ?? 0} accent="success" />
        <StatCard label="Partial" value={cal?.totals.partial ?? 0} accent="warning" />
        <StatCard label="Missing" value={cal?.totals.missing ?? 0} accent="danger" />
        <StatCard label="Leave" value={cal?.totals.leave ?? 0} />
        <StatCard
          label="Voice this month"
          value={hm(monthSeconds)}
          hint={`last seen ${ago(data.lastSeenAt)}`}
        />
      </StatGrid>

      {/* min-w-0: grid items default to min-width:auto and would otherwise be
          pushed wider than their track by their content on narrow screens. */}
      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="min-w-0 p-4 lg:col-span-3">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Daily activity — {monthLabel(month)}</h3>
          </div>
          <MonthCalendar days={cal?.days ?? []} />
          <div className="mt-4">
            <Legend />
          </div>
        </Card>

        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Card className="p-4">
            <h3 className="mb-3 text-sm font-semibold">Recent meetings</h3>
            {data.meetings.length === 0 ? (
              <p className="text-sm text-muted-foreground">No meeting records.</p>
            ) : (
              <ul className="max-h-64 space-y-2 overflow-y-auto pr-1 text-sm">
                {data.meetings.slice(0, 20).map((mt) => (
                  <li key={mt.meetingId} className="flex items-center justify-between gap-2">
                    <span className="truncate" title={mt.title}>
                      {mt.title}
                      <span className="ml-1 text-xs text-muted-foreground">
                        {new Date(mt.scheduledStart).toLocaleDateString()}
                      </span>
                    </span>
                    <Chip color={MEETING_COLOR[mt.status] ?? "default"} size="sm" variant="soft">
                      {mt.status}
                      {mt.minutesLate ? ` ${mt.minutesLate}m` : ""}
                    </Chip>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-4">
            <h3 className="mb-3 text-sm font-semibold">Leave history</h3>
            {data.leaves.length === 0 ? (
              <p className="text-sm text-muted-foreground">No leave requests.</p>
            ) : (
              <ul className="max-h-56 space-y-2 overflow-y-auto pr-1 text-sm">
                {data.leaves.map((l, i) => (
                  <li key={i} className="flex items-center justify-between gap-2">
                    <span className="truncate" title={l.reason}>
                      {l.type} · {new Date(l.startAt).toLocaleDateString()} →{" "}
                      {new Date(l.endAt).toLocaleDateString()}
                    </span>
                    <Chip
                      color={
                        l.status === "approved"
                          ? "success"
                          : l.status === "rejected"
                            ? "danger"
                            : "warning"
                      }
                      size="sm"
                      variant="soft"
                    >
                      {l.status}
                    </Chip>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
