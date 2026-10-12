import { Card } from "@heroui/react";
import { get, hm, type ComplianceReport, type Overview as OverviewData, type VoiceDay } from "../api";
import { useAsync } from "../lib/useAsync";
import { StatCard, StatGrid } from "../components/StatCard";
import { Legend } from "../components/status";

function Sparkline({ days }: { days: VoiceDay[] }) {
  const max = Math.max(1, ...days.map((d) => d.seconds));
  return (
    <div className="flex h-28 items-end gap-1">
      {days.map((d) => (
        <div
          key={d.day}
          title={`${d.day} — ${hm(d.seconds)} · ${d.members} member(s)`}
          className="min-h-[2px] flex-1 rounded-t bg-indigo-500/80 transition-colors hover:bg-indigo-400"
          style={{ height: `${Math.max(2, (d.seconds / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

export function OverviewPage({ days }: { days: number }) {
  const overview = useAsync(() => get<OverviewData>(`/api/overview?days=${days}`), [days]);
  const voice = useAsync(
    () => get<{ days: VoiceDay[] }>(`/api/voice?days=${days}`),
    [days]
  );
  const today = useAsync(() => get<ComplianceReport>("/api/compliance"), []);

  const o = overview.data;
  const t = today.data;
  const tally = { good: 0, breach: 0, pending: 0 };
  for (const r of t?.rows ?? []) {
    if (r.status === "compliant") tally.good++;
    else if (["late-login", "short-hours", "late-and-short", "absent"].includes(r.status))
      tally.breach++;
    else if (r.status === "in-progress" || r.status === "not-joined-yet") tally.pending++;
  }

  if (overview.error) return <p className="text-sm text-rose-400">Error: {overview.error}</p>;

  return (
    <div className="space-y-5">
      <StatGrid>
        <StatCard label="In voice now" value={o?.voice.liveNow ?? "—"} accent="success" />
        <StatCard label="Active today" value={o?.voice.activeToday ?? "—"} />
        <StatCard
          label="Voice total"
          value={o ? hm(o.voice.totalSeconds) : "—"}
          hint={o ? `${o.voice.from} → ${o.voice.to}` : undefined}
        />
        <StatCard label="Members tracked" value={o?.voice.trackedMembers ?? "—"} />
        <StatCard
          label="Meeting attendance"
          value={o ? `${o.meetings.attendancePct}%` : "—"}
          hint={o ? `${o.meetings.totalMeetings} meeting(s)` : undefined}
          accent="brand"
        />
      </StatGrid>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="min-w-0 p-4 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Voice hours per day</h2>
            <span className="text-xs text-muted-foreground">
              {voice.data ? `${voice.data.days.length} days` : ""}
            </span>
          </div>
          {voice.data ? (
            <Sparkline days={voice.data.days} />
          ) : (
            <div className="h-28 animate-pulse rounded bg-content2" />
          )}
        </Card>

        <Card className="min-w-0 p-4">
          <h2 className="mb-3 text-sm font-semibold">
            Today&apos;s rules {t ? <span className="text-muted-foreground">({t.day})</span> : null}
          </h2>
          {t && !t.workday ? (
            <p className="text-sm text-muted-foreground">Not a working day.</p>
          ) : (
            <div className="space-y-2 text-sm">
              <Row label="Following rules" value={tally.good} tone="text-emerald-400" />
              <Row label="Breaking rules" value={tally.breach} tone="text-rose-400" />
              <Row label="Still in progress" value={tally.pending} tone="text-muted-foreground" />
            </div>
          )}
          {t ? (
            <p className="mt-4 border-t border-default pt-3 text-xs text-muted-foreground">
              Join by <b>{t.policy.loginBy}</b> · serve <b>{t.policy.minHours}h</b> · window{" "}
              {t.policy.windowStart}–{t.policy.windowEnd}
            </p>
          ) : null}
        </Card>
      </div>

      <Legend />
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={`text-lg font-semibold tabular-nums ${tone}`}>{value}</span>
    </div>
  );
}
