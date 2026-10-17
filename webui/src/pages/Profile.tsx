import { useMemo, useState, type ReactNode } from "react";
import {
  ago,
  dateOf,
  dayLabel,
  get,
  hm,
  monthLabel,
  post,
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
import { LeaveDialog } from "../components/LeaveDialog";
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
  today,
}: {
  userId: string;
  month: string;
  onMonth: (m: string) => void;
  minMonth: string | null;
  policy: FilterOptions["policy"] | null;
  today: string;
}) {
  const atStart = Boolean(minMonth && month <= minMonth);
  const { data, error, loading, reload } = useAsync(
    () => get<Profile>(`/api/profile/${encodeURIComponent(userId)}?month=${month}`),
    [userId, month]
  );
  const [filter, setFilter] = useState<Filter>("all");
  const [granting, setGranting] = useState(false);
  const [toast, setToast] = useState<{ tone: "good" | "bad"; text: string } | null>(null);

  // Every day already covered by an approved leave, so the picker can flag them.
  const coveredDays = useMemo(() => {
    const out = new Set<string>();
    for (const l of data?.leaves ?? []) {
      if (l.status !== "approved") continue;
      if (l.approvedDays) {
        for (const d of l.approvedDays.split(",")) if (d) out.add(d);
        continue;
      }
      const end = new Date(l.endAt);
      for (let t = new Date(l.startAt); t <= end; t = new Date(t.getTime() + 86400_000)) {
        out.add(t.toISOString().slice(0, 10));
      }
    }
    return out;
  }, [data]);

  const flash = (tone: "good" | "bad", text: string) => {
    setToast({ tone, text });
    window.setTimeout(() => setToast(null), 6000);
  };

  const revoke = async (leaveId: number) => {
    if (!window.confirm("Revoke this leave? Those days count against attendance again.")) return;
    try {
      await post(`/api/profile/${encodeURIComponent(userId)}/leave/${leaveId}/revoke`, {});
      flash("good", `Leave #${leaveId} revoked`);
      reload();
    } catch (e) {
      flash("bad", (e as Error).message);
    }
  };

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
          <Button size="sm" variant="primary" className="mr-2" onClick={() => setGranting(true)}>
            + Grant leave
          </Button>
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
                    <b className="font-medium text-fg tabular-nums">{hm(ins.lifetime.voiceSeconds)}</b> voice
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
        <ListCard
          title="Leave history"
          count={data.leaves.length}
          empty="No leave requests."
          action={
            <button type="button" onClick={() => setGranting(true)} className="text-xs text-muted hover:text-fg">
              + Grant
            </button>
          }
        >
          {data.leaves.map((l) => {
            const viaDashboard = l.reviewedById?.startsWith("dashboard:");
            const days = l.approvedDays ? l.approvedDays.split(",").filter(Boolean) : null;
            return (
              <Row
                key={l.id}
                title={`#${l.id} · ${l.type} leave`}
                sub={
                  days
                    ? days.length <= 4
                      ? days.map((d) => dayLabel(d, { day: "numeric", month: "short" })).join(", ")
                      : `${days.length} days · ${dayLabel(days[0]!, { day: "numeric", month: "short" })} → ${dayLabel(days[days.length - 1]!, { day: "numeric", month: "short" })}`
                    : `${dateOf(l.startAt)} → ${dateOf(l.endAt)}`
                }
                note={`${l.reason}${viaDashboard ? ` — approved on dashboard by ${l.reviewedById!.slice("dashboard:".length)}` : ""}`}
                right={
                  <div className="flex flex-col items-end gap-1">
                    <Badge tone={l.status === "approved" ? "good" : l.status === "pending" ? "warn" : "bad"}>{l.status}</Badge>
                    {viaDashboard && l.status === "approved" ? (
                      <button type="button" onClick={() => revoke(l.id)} className="text-[11px] text-dim hover:text-rose-300">
                        revoke
                      </button>
                    ) : null}
                  </div>
                }
              />
            );
          })}
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

      {granting ? (
        <LeaveDialog
          userId={userId}
          name={m.fullName}
          startMonth={month}
          today={today}
          workdays={policy?.workdays ?? [1, 2, 3, 4, 5]}
          coveredDays={coveredDays}
          onClose={() => setGranting(false)}
          onGranted={(msg) => {
            setGranting(false);
            flash("good", msg);
            reload();
          }}
        />
      ) : null}

      {toast ? (
        <div
          role="status"
          className={cx(
            "fixed right-4 bottom-4 z-50 max-w-sm rounded-xl border px-4 py-3 text-sm shadow-2xl backdrop-blur",
            toast.tone === "good" ? "border-emerald-400/30 bg-emerald-950/80 text-emerald-200" : "border-rose-400/30 bg-rose-950/80 text-rose-200"
          )}
        >
          {toast.text}
        </div>
      ) : null}
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

function ListCard({
  title,
  count,
  empty,
  action,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader
        title={title}
        action={
          <div className="flex items-center gap-3">
            {action}
            <Badge>{count}</Badge>
          </div>
        }
      />
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
