import { useState, type ReactNode } from "react";
import {
  ago,
  dateOf,
  dayLabel,
  get,
  hm,
  monthLabel,
  shiftMonth,
  type FilterOptions,
  type Profile,
  type ViolationKind,
} from "../api";
import { useAsync } from "../lib/useAsync";
import { navigate } from "../lib/router";
import { MonthCalendar } from "../components/MonthCalendar";
import { Legend, VIOLATION_META } from "../components/status";
import { DailyHours, JoinTimeline } from "../components/charts";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  Segmented,
  Skeleton,
  Stat,
  StatStrip,
  cx,
  rateTone,
  type Tone,
} from "../components/ui";

const MEETING_TONE: Record<string, Tone> = {
  present: "good",
  late: "warn",
  absent: "bad",
  excused: "neutral",
};

type Filter = "all" | "attendance" | "meetings" | "warnings";

export function ProfilePage({
  userId,
  month,
  onMonth,
  minMonth,
  policy,
}: {
  userId: string;
  month: string;
  onMonth: (m: string) => void;
  minMonth: string | null;
  policy: FilterOptions["policy"] | null;
}) {
  const atStart = Boolean(minMonth && month <= minMonth);
  const { data, error, loading } = useAsync(
    () => get<Profile>(`/api/profile/${encodeURIComponent(userId)}?month=${month}`),
    [userId, month]
  );
  const [filter, setFilter] = useState<Filter>("all");

  if (error) return <ErrorNote message={error} />;
  if (loading && !data) return <ProfileSkeleton />;
  if (!data?.member) return <Empty>Member not found.</Empty>;

  const m = data.member;
  const ins = data.insights;
  const cal = data.calendar;
  const loginBy = policy?.loginBy ?? "14:00";
  const minHours = policy?.minHours ?? 5.5;

  const violations = (ins?.violations ?? []).filter((v) =>
    filter === "all"
      ? true
      : filter === "attendance"
        ? ["absent", "late-login", "short-hours"].includes(v.kind)
        : filter === "meetings"
          ? v.kind.startsWith("meeting")
          : v.kind === "warning"
  );
  const counts = (ins?.violations ?? []).reduce<Partial<Record<ViolationKind, number>>>((a, v) => {
    a[v.kind] = (a[v.kind] ?? 0) + 1;
    return a;
  }, {});
  const totalViolations = ins?.violations.length ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button size="sm" variant="ghost" onClick={() => (history.length > 1 ? history.back() : navigate("/members"))}>
          ← Back
        </Button>
        <div className="flex items-center gap-1.5">
          <Button size="sm" disabled={atStart} onClick={() => onMonth(shiftMonth(month, -1))}>
            ←
          </Button>
          <span className="min-w-[9.5rem] text-center text-sm font-medium">{monthLabel(month)}</span>
          <Button size="sm" onClick={() => onMonth(shiftMonth(month, 1))}>
            →
          </Button>
        </div>
      </div>

      {/* Identity */}
      <Card className="relative overflow-hidden">
        <div className="bg-grid pointer-events-none absolute inset-x-0 top-0 h-40" />
        <div className="relative flex flex-col gap-6 p-6 md:flex-row md:items-start">
          <Avatar name={m.fullName} size={72} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-gradient text-2xl font-semibold tracking-tight sm:text-3xl">{m.fullName}</h1>
              {data.live ? (
                <Badge tone="good" dot>
                  In voice now
                </Badge>
              ) : (
                <Badge>Last seen {ago(data.lastSeenAt)}</Badge>
              )}
              <Badge tone={m.verificationStatus === "verified" ? "info" : "warn"}>{m.verificationStatus}</Badge>
              {ins?.details.flagged ? <Badge tone="bad">Flagged for HR review</Badge> : null}
              {ins?.projectRank ? (
                <Badge>
                  #{ins.projectRank.rank} of {ins.projectRank.of} in {m.project} this month
                </Badge>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-muted">
              {[m.project ?? "No project", m.batch, m.module ? `Module ${m.module}` : null, m.pod ? `Pod ${m.pod}` : null]
                .filter(Boolean)
                .join(" · ")}
            </p>

            <dl className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3 lg:grid-cols-5">
              <Detail label="Discord" value={m.tag ? `@${m.tag}` : "—"} />
              <Detail label="Display name" value={m.displayName ?? "—"} />
              <Detail label="User ID" value={<span className="font-mono text-xs">{m.userId}</span>} />
              <Detail label="Batch" value={m.batch ?? "—"} />
              <Detail label="Project" value={m.project ?? "—"} />
              <Detail label="Module / Pod" value={`${m.module ?? "—"} / ${m.pod ?? "—"}`} />
              <Detail label="Joined server" value={dateOf(m.joinedAt)} />
              <Detail label="Registered" value={dateOf(ins?.details.registrationDate ?? null)} />
              <Detail label="Tracked since" value={ins?.details.trackedFrom ? dayLabel(ins.details.trackedFrom, { day: "numeric", month: "short", year: "numeric" }) : "—"} />
              <Detail label="Last seen" value={data.live ? "Now" : data.lastSeenAt ? new Date(data.lastSeenAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Never"} />
            </dl>
          </div>
        </div>
      </Card>

      {/* Month KPIs */}
      {ins ? (
        <StatStrip cols={6}>
          <Stat
            label="Compliance"
            value={`${ins.period.complianceRate}%`}
            tone={ins.period.workdays ? rateTone(ins.period.complianceRate) : undefined}
            hint={`${cal?.totals.good ?? 0} of ${ins.period.workdays} working days`}
          />
          <Stat
            label="Violations"
            value={totalViolations}
            tone={totalViolations ? "bad" : "good"}
            hint={`${ins.period.absent} absent · ${ins.period.late} late · ${ins.period.short} short`}
          />
          <Stat label="Voice served" value={hm(ins.period.voiceSeconds)} hint={`${hm(ins.period.avgSecondsPerPresentDay)} per present day`} />
          <Stat
            label="On-time logins"
            value={`${ins.period.onTimeRate}%`}
            tone={rateTone(ins.period.onTimeRate)}
            hint={ins.period.avgFirstJoin ? `avg first join ${ins.period.avgFirstJoin} (cutoff ${loginBy})` : "no logins this month"}
          />
          <Stat
            label="Meetings"
            value={`${ins.meetingStats.pct}%`}
            tone={ins.meetingStats.present + ins.meetingStats.late + ins.meetingStats.absent ? rateTone(ins.meetingStats.pct) : undefined}
            hint={`${ins.meetingStats.absent} missed · ${ins.meetingStats.late} late (all time)`}
          />
          <Stat
            label="Streak"
            value={ins.lifetime.absentStreak ? `−${ins.lifetime.absentStreak}d` : `${ins.lifetime.currentStreak}d`}
            tone={ins.lifetime.absentStreak ? "bad" : ins.lifetime.currentStreak ? "good" : undefined}
            hint={ins.lifetime.absentStreak ? `absent ${ins.lifetime.absentStreak} working days in a row` : `best run ${ins.lifetime.bestStreak} completed days`}
          />
        </StatStrip>
      ) : null}

      {/* Violations */}
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="min-w-0 xl:col-span-2">
          <CardHeader
            title={`Violations — ${monthLabel(month)}`}
            subtitle={`Every rule this member broke: join by ${loginBy}, serve ${minHours}h on working days, attend meetings`}
            action={
              <Segmented
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: "All" },
                  { value: "attendance", label: "Attendance" },
                  { value: "meetings", label: "Meetings" },
                  { value: "warnings", label: "Warnings" },
                ]}
              />
            }
          />
          <div className="flex flex-wrap gap-2 px-5 pt-4">
            {(Object.keys(VIOLATION_META) as ViolationKind[]).map((k) => (
              <Badge key={k} tone={counts[k] ? VIOLATION_META[k].tone : "neutral"}>
                {VIOLATION_META[k].label} <b className="tabular-nums">{counts[k] ?? 0}</b>
              </Badge>
            ))}
          </div>
          <div className="scroll-thin mt-4 max-h-[440px] overflow-y-auto border-t border-line">
            {violations.length === 0 ? (
              <Empty>{totalViolations ? "Nothing in this category." : "No violations this month. 🎉"}</Empty>
            ) : (
              <ul className="divide-y divide-line/60">
                {violations.map((v, k) => (
                  <li key={`${v.day}-${v.kind}-${k}`} className="flex items-start gap-4 px-5 py-3">
                    <div className="w-[76px] shrink-0 pt-0.5">
                      <div className="text-sm font-medium tabular-nums">{dayLabel(v.day, { day: "numeric", month: "short" })}</div>
                      <div className="text-[11px] text-dim">{dayLabel(v.day, { weekday: "long" })}</div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={VIOLATION_META[v.kind].tone} dot>
                          {VIOLATION_META[v.kind].label}
                        </Badge>
                        <SeverityPill severity={v.severity} />
                      </div>
                      <p className="mt-1 text-sm text-muted">{v.detail}</p>
                      {v.servedSeconds !== undefined && v.requiredSeconds ? (
                        <div className="mt-2 h-1 max-w-xs overflow-hidden rounded-full bg-white/[0.06]">
                          <div
                            className="h-full rounded-full bg-amber-400"
                            style={{ width: `${Math.min(100, (v.servedSeconds / v.requiredSeconds) * 100)}%` }}
                          />
                        </div>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        {ins ? (
          <Card className="min-w-0">
            <CardHeader title="Lifetime record" subtitle={`Since ${dayLabel(ins.lifetime.from, { day: "numeric", month: "short", year: "numeric" })}`} />
            <div className="space-y-5 p-5 pt-4">
              <div className="flex items-end justify-between">
                <div>
                  <div
                    className={cx(
                      "text-4xl font-semibold tracking-tight tabular-nums",
                      { good: "text-emerald-300", warn: "text-amber-300", bad: "text-rose-300" }[
                        rateTone(ins.lifetime.complianceRate) as "good" | "warn" | "bad"
                      ]
                    )}
                  >
                    {ins.lifetime.complianceRate}%
                  </div>
                  <div className="text-xs text-dim">overall compliance</div>
                </div>
                <div className="text-right text-xs text-dim">
                  <div>
                    <b className="font-medium text-fg tabular-nums">{Math.round(ins.lifetime.voiceSeconds / 3600)}h</b> voice
                  </div>
                  <div>
                    <b className="font-medium text-fg tabular-nums">{ins.lifetime.presentDays}</b> days present
                  </div>
                </div>
              </div>
              <StackBar
                parts={[
                  { label: "Completed", value: ins.lifetime.good, color: "bg-emerald-400" },
                  { label: "Partial", value: ins.lifetime.partial, color: "bg-amber-400" },
                  { label: "Absent", value: ins.lifetime.missing, color: "bg-rose-400" },
                  { label: "Leave", value: ins.lifetime.leave, color: "bg-orange-400" },
                ]}
              />
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line text-sm">
                <Counter label="Absences" value={ins.lifetimeViolations.absent} tone="bad" />
                <Counter label="Late logins" value={ins.lifetimeViolations.late} tone="warn" />
                <Counter label="Short-hour days" value={ins.lifetimeViolations.short} tone="warn" />
                <Counter label="Missed meetings" value={ins.lifetimeViolations.meetingAbsent} tone="bad" />
                <Counter label="Late to meetings" value={ins.lifetimeViolations.meetingLate} tone="warn" />
                <Counter label="Warnings" value={ins.lifetimeViolations.warnings} tone="bad" />
              </div>
            </div>
          </Card>
        ) : null}
      </div>

      {/* Activity */}
      <div className="grid gap-4 xl:grid-cols-5">
        <Card className="min-w-0 xl:col-span-3">
          <CardHeader title="Daily activity" subtitle={`${monthLabel(month)} · hover a day for details`} />
          <div className="space-y-6 p-5 pt-4">
            {ins ? <DailyHours days={ins.daily} requiredHours={minHours} loginBy={loginBy} /> : null}
            <div>
              <div className="mb-2 text-xs font-medium text-muted">First-join time per day</div>
              {ins ? <JoinTimeline days={ins.daily} loginBy={loginBy} /> : null}
            </div>
          </div>
        </Card>
        <Card className="min-w-0 xl:col-span-2">
          <CardHeader title="Calendar" subtitle={monthLabel(month)} />
          <div className="mx-auto max-w-md p-5 pt-4 xl:max-w-none">
            <MonthCalendar days={cal?.days ?? []} />
            <div className="mt-4">
              <Legend />
            </div>
          </div>
        </Card>
      </div>

      {/* Records */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <ListCard title="Meetings" count={data.meetings.length} empty="No meeting records.">
          {data.meetings.slice(0, 30).map((mt) => (
            <Row
              key={mt.meetingId}
              title={mt.title}
              sub={new Date(mt.scheduledStart).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
              right={
                <Badge tone={MEETING_TONE[mt.status] ?? "neutral"}>
                  {mt.status}
                  {mt.minutesLate ? ` +${mt.minutesLate}m` : ""}
                </Badge>
              }
            />
          ))}
        </ListCard>
        <ListCard title="Leave history" count={data.leaves.length} empty="No leave requests.">
          {data.leaves.map((l, k) => (
            <Row
              key={k}
              title={`${l.type} leave`}
              sub={`${dateOf(l.startAt)} → ${dateOf(l.endAt)}`}
              note={l.reason}
              right={<Badge tone={l.status === "approved" ? "good" : l.status === "rejected" ? "bad" : "warn"}>{l.status}</Badge>}
            />
          ))}
        </ListCard>
        <ListCard title="Warnings" count={ins?.warns.length ?? 0} empty="No warnings on record.">
          {(ins?.warns ?? []).map((w, k) => (
            <Row key={k} title={w.reason} sub={`by ${w.by} · ${dateOf(w.at)}`} right={<Badge tone="bad">warn</Badge>} />
          ))}
        </ListCard>
        <ListCard title="Tickets opened" count={ins?.tickets.length ?? 0} empty="No tickets opened.">
          {(ins?.tickets ?? []).map((t) => (
            <Row
              key={t.id}
              title={`#${t.id} · ${t.subject}`}
              sub={`${t.type} · ${dateOf(t.createdAt)}`}
              right={<Badge tone={t.status === "closed" ? "neutral" : "info"}>{t.status}</Badge>}
            />
          ))}
        </ListCard>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 bg-panel-2 px-3.5 py-2.5">
      <dt className="text-[11px] text-dim">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium" title={typeof value === "string" ? value : undefined}>
        {value}
      </dd>
    </div>
  );
}

function SeverityPill({ severity }: { severity: "high" | "medium" | "low" }) {
  const cls =
    severity === "high" ? "text-rose-300" : severity === "medium" ? "text-amber-300" : "text-dim";
  return (
    <span className={cx("inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide", cls)}>
      <span className="flex gap-0.5">
        {[0, 1, 2].map((k) => (
          <span
            key={k}
            className={cx(
              "h-2.5 w-1 rounded-sm",
              k < (severity === "high" ? 3 : severity === "medium" ? 2 : 1) ? "bg-current" : "bg-white/10"
            )}
          />
        ))}
      </span>
      {severity}
    </span>
  );
}

function StackBar({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-white/[0.06]">
        {total
          ? parts.map((p) => (
              <div key={p.label} className={p.color} style={{ width: `${(p.value / total) * 100}%` }} title={`${p.label}: ${p.value}`} />
            ))
          : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-dim">
        {parts.map((p) => (
          <span key={p.label} className="flex items-center gap-1.5">
            <span className={cx("size-2 rounded-sm", p.color)} />
            {p.label} <b className="font-medium text-fg tabular-nums">{p.value}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

function Counter({ label, value, tone }: { label: string; value: number; tone: "bad" | "warn" }) {
  return (
    <div className="bg-panel-2 px-3.5 py-2.5">
      <div className={cx("text-lg font-semibold tabular-nums", value ? (tone === "bad" ? "text-rose-300" : "text-amber-300") : "text-dim")}>
        {value}
      </div>
      <div className="text-[11px] text-dim">{label}</div>
    </div>
  );
}

function ListCard({ title, count, empty, children }: { title: string; count: number; empty: string; children: ReactNode }) {
  return (
    <Card className="min-w-0">
      <CardHeader title={title} action={<Badge>{count}</Badge>} />
      <div className="scroll-thin mt-3 max-h-72 overflow-y-auto border-t border-line">
        {count === 0 ? <Empty>{empty}</Empty> : <ul className="divide-y divide-line/60">{children}</ul>}
      </div>
    </Card>
  );
}

function Row({ title, sub, note, right }: { title: string; sub: string; note?: string; right: ReactNode }) {
  return (
    <li className="flex items-start justify-between gap-3 px-5 py-2.5">
      <div className="min-w-0">
        <div className="truncate text-sm" title={title}>
          {title}
        </div>
        <div className="text-[11px] text-dim">{sub}</div>
        {note ? (
          <div className="mt-0.5 line-clamp-2 text-[11px] text-muted" title={note}>
            {note}
          </div>
        ) : null}
      </div>
      <div className="shrink-0">{right}</div>
    </li>
  );
}

function ProfileSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-56" />
      <Skeleton className="h-28" />
      <div className="grid gap-4 xl:grid-cols-3">
        <Skeleton className="h-96 xl:col-span-2" />
        <Skeleton className="h-96" />
      </div>
    </div>
  );
}
