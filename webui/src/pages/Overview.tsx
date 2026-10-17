import { dayLabel, get, hm, type OrgInsights, type Overview as OverviewData } from "../api";
import { useAsync } from "../lib/useAsync";
import { navigate } from "../lib/router";
import {
  Avatar,
  Badge,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  Meter,
  PageHeader,
  Segmented,
  Skeleton,
  Stat,
  StatStrip,
  cx,
  rateTone,
} from "../components/ui";
import { ArrivalHistogram, ComplianceTrend, Donut, VoiceArea } from "../components/charts";

const RANGES = [
  { value: "1", label: "Today" },
  { value: "7", label: "7d" },
  { value: "30", label: "30d" },
  { value: "90", label: "90d" },
  { value: "0", label: "All" },
];

function pct(part: number, whole: number): number {
  return whole ? Math.round((part / whole) * 1000) / 10 : 0;
}

function openProfile(userId: string) {
  navigate(`/member/${encodeURIComponent(userId)}`);
}

export function OverviewPage({ days, onDays }: { days: string; onDays: (d: string) => void }) {
  const insights = useAsync(() => get<OrgInsights>(`/api/insights?days=${days}`), [days]);
  const overview = useAsync(() => get<OverviewData>(`/api/overview?days=${days}`), [days]);
  const i = insights.data;
  const o = overview.data;
  const loading = insights.loading && !i;

  const violations = i ? i.totals.late + i.totals.short + i.totals.lateAndShort + i.totals.missing : 0;
  const registered = i ? i.members - i.unassignedMembers : 0;
  const workdays = i ? i.trend.filter((t) => t.workday && t.settled).length : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <>
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
            </span>
            {o ? `${o.voice.liveNow} in voice now · ${o.voice.activeToday} active today` : "Connecting…"}
          </>
        }
        title="Overview"
        description={
          i
            ? `${dayLabel(i.range.from, { day: "numeric", month: "short" })} → ${dayLabel(i.range.to, { day: "numeric", month: "short", year: "numeric" })} · ${workdays} settled working day${workdays === 1 ? "" : "s"} · rules: join by ${i.policy.loginBy}, serve ${i.policy.minHours}h`
            : "Attendance health, rule violations and who needs attention."
        }
        action={<Segmented value={days} onChange={onDays} options={RANGES} />}
      />

      {insights.error ? <ErrorNote message={insights.error} /> : null}

      <StatStrip cols={6}>
        <Stat
          label="Compliance"
          value={i ? `${i.complianceRate}%` : "—"}
          tone={i ? rateTone(i.complianceRate) : undefined}
          hint={i ? `${i.totals.good.toLocaleString()} of ${(i.totals.good + i.totals.partial + i.totals.missing).toLocaleString()} member-days` : " "}
        />
        <Stat
          label="Active members"
          value={i ? i.activeMembers.toLocaleString() : "—"}
          hint={i ? `${pct(i.activeMembers, registered)}% of ${registered} registered` : " "}
        />
        <Stat
          label="Violations"
          value={i ? violations.toLocaleString() : "—"}
          tone={violations ? "bad" : undefined}
          hint={i ? `${i.totals.missing.toLocaleString()} absences · avg ${i.avgLateMinutes}m late` : " "}
        />
        <Stat
          label="Voice served"
          value={i ? `${Math.round(i.totals.voiceSeconds / 3600).toLocaleString()}h` : "—"}
          hint={
            i && i.activeMembers
              ? `${hm(i.projects.reduce((a, p) => a + p.voiceSeconds, 0) / Math.max(1, i.trend.reduce((a, t) => a + t.active, 0)))} per present day`
              : " "
          }
        />
        <Stat
          label="Meetings"
          value={o ? `${o.meetings.attendancePct}%` : "—"}
          tone={o ? rateTone(o.meetings.attendancePct) : undefined}
          hint={o ? `${o.meetings.totalMeetings} held · ${o.meetings.absent} no-shows` : " "}
        />
        <Stat
          label="Open items"
          value={i ? i.pendingLeaves + i.openTickets : "—"}
          tone="info"
          hint={i ? `${i.pendingLeaves} leave requests · ${i.openTickets} tickets` : " "}
        />
      </StatStrip>

      {i ? <InsightCallouts i={i} /> : null}

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="min-w-0 xl:col-span-2">
          <CardHeader
            title="Daily compliance"
            subtitle="Member-days per working day: completed, partial (late and/or short), absent, on leave"
          />
          <div className="p-5 pt-4">{i ? <ComplianceTrend days={i.trend} /> : <Skeleton className="h-[200px]" />}</div>
        </Card>
        <LatestWorkday i={i} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <ViolationBreakdown i={i} />
        <Card className="min-w-0">
          <CardHeader title="First-login times" subtitle="When members first join on working days (30-min buckets)" />
          <div className="p-5 pt-4">
            {i ? <ArrivalHistogram buckets={i.arrivals} cutoff={i.policy.loginBy} /> : <Skeleton className="h-[160px]" />}
          </div>
        </Card>
        <Card className="min-w-0 lg:col-span-2 xl:col-span-1">
          <CardHeader title="Voice activity" subtitle="Total hours served and members present per day" />
          <div className="p-5 pt-4">{i ? <VoiceArea days={i.trend} /> : <Skeleton className="h-[180px]" />}</div>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-5">
        <Card className="min-w-0 xl:col-span-3">
          <CardHeader
            title="Needs attention"
            subtitle="Members who attend but break the rules most · absences weigh 3× · no-shows are counted separately above"
            action={<Badge tone="bad">{i?.topViolators.length ?? 0}</Badge>}
          />
          <div className="mt-3 overflow-x-auto">
            {loading ? (
              <div className="space-y-2 p-5">
                {Array.from({ length: 6 }, (_, k) => (
                  <Skeleton key={k} className="h-9" />
                ))}
              </div>
            ) : i && i.topViolators.length ? (
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-y border-line text-left text-[11px] tracking-[0.06em] text-dim uppercase">
                    <th className="px-5 py-2 font-medium">Member</th>
                    <th className="px-2 py-2 text-right font-medium">Absent</th>
                    <th className="px-2 py-2 text-right font-medium">Late</th>
                    <th className="px-2 py-2 text-right font-medium">Short</th>
                    <th className="px-2 py-2 text-right font-medium">Avg late</th>
                    <th className="px-5 py-2 text-right font-medium">Compliance</th>
                  </tr>
                </thead>
                <tbody>
                  {i.topViolators.map((v) => (
                    <tr
                      key={v.userId}
                      onClick={() => openProfile(v.userId)}
                      className="cursor-pointer border-b border-line/60 transition-colors last:border-0 hover:bg-white/[0.03]"
                    >
                      <td className="px-5 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={v.fullName} size={28} />
                          <div className="min-w-0">
                            <div className="truncate font-medium">{v.fullName}</div>
                            <div className="truncate text-xs text-dim">{[v.project, v.batch].filter(Boolean).join(" · ")}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-2 text-right tabular-nums text-rose-300">{v.absent || "–"}</td>
                      <td className="px-2 text-right tabular-nums text-amber-300">{v.late || "–"}</td>
                      <td className="px-2 text-right tabular-nums text-amber-300">{v.short || "–"}</td>
                      <td className="px-2 text-right tabular-nums text-muted">{v.avgLateMinutes ? `${v.avgLateMinutes}m` : "–"}</td>
                      <td className="px-5 text-right">
                        <Badge tone={rateTone(v.rate)}>{v.rate}%</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>No violations in this range.</Empty>
            )}
          </div>
        </Card>

        <Card className="min-w-0 xl:col-span-2">
          <CardHeader title="Most consistent" subtitle="Most completed days, then compliance rate" />
          <ul className="mt-3 divide-y divide-line/60">
            {loading
              ? Array.from({ length: 6 }, (_, k) => (
                  <li key={k} className="px-5 py-2.5">
                    <Skeleton className="h-8" />
                  </li>
                ))
              : (i?.topPerformers ?? []).map((p, k) => (
                  <li
                    key={p.userId}
                    onClick={() => openProfile(p.userId)}
                    className="flex cursor-pointer items-center gap-3 px-5 py-2.5 transition-colors hover:bg-white/[0.03]"
                  >
                    <span className="w-4 text-xs text-dim tabular-nums">{k + 1}</span>
                    <Avatar name={p.fullName} size={28} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{p.fullName}</div>
                      <div className="truncate text-xs text-dim">
                        {p.project} · {Math.round(p.voiceSeconds / 3600)}h voice
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-medium tabular-nums text-emerald-300">{p.good}d</div>
                      <div className="text-[11px] text-dim tabular-nums">{p.rate}%</div>
                    </div>
                  </li>
                ))}
            {i && !i.topPerformers.length ? <Empty>No completed days yet in this range.</Empty> : null}
          </ul>
        </Card>
      </div>

      <ProjectTable i={i} />

      <Card>
        <CardHeader
          title="Recent meetings"
          subtitle="Attendance = present + late over everyone expected (excused excluded)"
          action={
            <button type="button" onClick={() => navigate("/meetings")} className="text-xs text-muted hover:text-fg">
              All meetings →
            </button>
          }
        />
        <div className="mt-3 grid gap-px overflow-hidden border-t border-line bg-line sm:grid-cols-2 xl:grid-cols-4">
          {(i?.meetings ?? []).slice(0, 8).map((m) => (
            <div
              key={m.id}
              onClick={() => navigate(`/meetings/${m.id}`)}
              className="cursor-pointer bg-panel p-5 transition-colors hover:bg-panel-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{m.title}</div>
                  <div className="text-xs text-dim">
                    {new Date(m.startAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
                <Badge tone={rateTone(m.pct)}>{m.pct}%</Badge>
              </div>
              <div className="mt-3">
                <Meter value={m.pct} tone={rateTone(m.pct)} />
              </div>
              <div className="mt-2 flex gap-3 text-[11px] text-dim tabular-nums">
                <span>
                  <b className="font-medium text-emerald-300">{m.present}</b> on time
                </span>
                <span>
                  <b className="font-medium text-amber-300">{m.late}</b> late
                </span>
                <span>
                  <b className="font-medium text-rose-300">{m.absent}</b> absent
                </span>
              </div>
            </div>
          ))}
          {i && !i.meetings.length ? (
            <div className="bg-panel sm:col-span-2 xl:col-span-4">
              <Empty>No meetings in this range.</Empty>
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

/** Plain-language findings computed from the numbers. */
function InsightCallouts({ i }: { i: OrgInsights }) {
  const items: { tone: "bad" | "warn" | "good" | "info"; title: string; body: string }[] = [];
  const settledViolations = i.totals.late + i.totals.short + i.totals.lateAndShort + i.totals.missing;
  if (settledViolations) {
    items.push({
      tone: "bad",
      title: `${pct(i.totals.missing, settledViolations)}% of violations are absences`,
      body: `${i.totals.missing.toLocaleString()} absent member-days vs ${(i.totals.late + i.totals.short + i.totals.lateAndShort).toLocaleString()} partial days.`,
    });
  }
  const totalArr = i.arrivals.reduce((a, b) => a + b.count, 0);
  const lateArr = i.arrivals.filter((b) => b.late).reduce((a, b) => a + b.count, 0);
  if (totalArr) {
    const peak = [...i.arrivals].sort((a, b) => b.count - a.count)[0]!;
    items.push({
      tone: lateArr / totalArr > 0.15 ? "warn" : "good",
      title: `Peak login at ${peak.label}`,
      body: `${pct(lateArr, totalArr)}% of first logins come after ${i.policy.loginBy}. Average late arrival: ${i.avgLateMinutes} min.`,
    });
  }
  const ranked = i.projects.filter(
    (p) => p.project !== "Unassigned" && p.members >= 3 && p.good + p.partial + p.missing > 0
  );
  if (ranked.length >= 2) {
    const best = ranked[0]!;
    const worst = ranked[ranked.length - 1]!;
    items.push({
      tone: "info",
      title: `${best.project} leads at ${best.rate}%`,
      body: `${worst.project} trails at ${worst.rate}% with ${worst.missing.toLocaleString()} absent days across ${worst.members} members.`,
    });
  }
  if (i.inactiveMembers || i.unassignedMembers) {
    items.push({
      tone: "warn",
      title: `${i.inactiveMembers} registered members never joined`,
      body: `No voice presence in this range. Another ${i.unassignedMembers} accounts have no project assigned.`,
    });
  }
  if (!items.length) return null;
  const dot = { bad: "bg-rose-400", warn: "bg-amber-400", good: "bg-emerald-400", info: "bg-indigo-300" };
  return (
    <div className="grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 xl:grid-cols-4">
      {items.map((it) => (
        <div key={it.title} className="bg-panel p-5">
          <div className="flex items-center gap-2">
            <span className={cx("size-1.5 rounded-full", dot[it.tone])} />
            <span className="text-[11px] font-medium tracking-[0.08em] text-dim uppercase">Insight</span>
          </div>
          <div className="mt-2 text-sm font-medium text-fg">{it.title}</div>
          <p className="mt-1 text-xs leading-relaxed text-muted">{it.body}</p>
        </div>
      ))}
    </div>
  );
}

function LatestWorkday({ i }: { i: OrgInsights | null }) {
  const s = i?.latestWorkday;
  const segs = s
    ? [
        { label: "Following rules", value: s.good, color: "#34d399" },
        { label: "Late login", value: s.late, color: "#fbbf24" },
        { label: "Short hours", value: s.short, color: "#f59e0b" },
        { label: "Late + short", value: s.lateAndShort, color: "#fb923c" },
        { label: "Absent", value: s.absent, color: "#fb7185" },
        { label: "On leave", value: s.leave, color: "#a5b4fc" },
      ]
    : [];
  const counted = s ? s.good + s.late + s.short + s.lateAndShort + s.absent : 0;
  return (
    <Card className="min-w-0">
      <CardHeader
        title="Last working day"
        subtitle={s ? dayLabel(s.day, { weekday: "long", day: "numeric", month: "long" }) : "Most recent settled working day"}
      />
      {s ? (
        <div className="flex flex-col items-center gap-5 p-5 sm:flex-row xl:flex-col 2xl:flex-row">
          <Donut segments={segs} center={`${pct(s.good, counted)}%`} sub="followed rules" />
          <ul className="w-full space-y-1.5 text-sm">
            {segs.map((g) => (
              <li key={g.label} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-muted">
                  <span className="size-2 rounded-sm" style={{ background: g.color }} />
                  {g.label}
                </span>
                <span className="font-medium tabular-nums">{g.value}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : i ? (
        <Empty>No settled working day in this range.</Empty>
      ) : (
        <div className="p-5">
          <Skeleton className="h-[180px]" />
        </div>
      )}
    </Card>
  );
}

function ViolationBreakdown({ i }: { i: OrgInsights | null }) {
  const rows = i
    ? [
        { label: "Absent (no presence)", value: i.totals.missing, color: "bg-rose-400" },
        { label: "Late login + short hours", value: i.totals.lateAndShort, color: "bg-orange-400" },
        { label: "Short hours only", value: i.totals.short, color: "bg-amber-400" },
        { label: "Late login only", value: i.totals.late, color: "bg-yellow-300" },
      ]
    : [];
  const total = rows.reduce((a, r) => a + r.value, 0);
  return (
    <Card className="min-w-0">
      <CardHeader title="Violation types" subtitle={i ? `${total.toLocaleString()} rule breaks in range` : "Rule breaks by type"} />
      <div className="space-y-4 p-5 pt-4">
        {i ? (
          <>
            {rows.map((r) => (
              <div key={r.label}>
                <div className="mb-1.5 flex items-baseline justify-between text-sm">
                  <span className="text-muted">{r.label}</span>
                  <span className="tabular-nums">
                    <b className="font-medium">{r.value.toLocaleString()}</b>
                    <span className="ml-1.5 text-xs text-dim">{pct(r.value, total)}%</span>
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                  <div className={cx("h-full rounded-full", r.color)} style={{ width: `${pct(r.value, total)}%` }} />
                </div>
              </div>
            ))}
            <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-line bg-line text-center">
              <div className="bg-panel-2 p-3">
                <div className="text-lg font-semibold tabular-nums">{i.avgLateMinutes}m</div>
                <div className="text-[11px] text-dim">avg lateness</div>
              </div>
              <div className="bg-panel-2 p-3">
                <div className="text-lg font-semibold tabular-nums">{i.totals.leave.toLocaleString()}</div>
                <div className="text-[11px] text-dim">leave days</div>
              </div>
              <div className="bg-panel-2 p-3">
                <div className="text-lg font-semibold tabular-nums">{i.warnings}</div>
                <div className="text-[11px] text-dim">warnings</div>
              </div>
            </div>
          </>
        ) : (
          <Skeleton className="h-[200px]" />
        )}
      </div>
    </Card>
  );
}

function ProjectTable({ i }: { i: OrgInsights | null }) {
  return (
    <Card className="min-w-0">
      <CardHeader title="Projects" subtitle="Compliance, presence and violations per project · click to open its calendar" />
      <div className="mt-3 overflow-x-auto">
        {i ? (
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-y border-line text-left text-[11px] tracking-[0.06em] text-dim uppercase">
                <th className="px-5 py-2 font-medium">Project</th>
                <th className="px-2 py-2 text-right font-medium">Members</th>
                <th className="px-2 py-2 text-right font-medium">Active</th>
                <th className="w-[22%] px-4 py-2 font-medium">Compliance</th>
                <th className="px-2 py-2 text-right font-medium">Completed</th>
                <th className="px-2 py-2 text-right font-medium">Partial</th>
                <th className="px-2 py-2 text-right font-medium">Absent</th>
                <th className="px-2 py-2 text-right font-medium">Leave</th>
                <th className="px-5 py-2 text-right font-medium">Avg / present day</th>
              </tr>
            </thead>
            <tbody>
              {i.projects.map((p) => (
                <tr
                  key={p.project}
                  onClick={() => (p.project !== "Unassigned" ? navigate("/calendar") : undefined)}
                  className={cx(
                    "border-b border-line/60 last:border-0",
                    p.project === "Unassigned" ? "text-dim" : "cursor-pointer hover:bg-white/[0.03]"
                  )}
                >
                  <td className="px-5 py-2.5 font-medium">{p.project}</td>
                  <td className="px-2 text-right tabular-nums">{p.members}</td>
                  <td className="px-2 text-right tabular-nums text-muted">
                    {p.active}
                    <span className="ml-1 text-xs text-dim">{pct(p.active, p.members)}%</span>
                  </td>
                  <td className="px-4">
                    <div className="flex items-center gap-2.5">
                      <div className="flex-1">
                        <Meter value={p.rate} tone={rateTone(p.rate)} />
                      </div>
                      <span className="w-12 text-right text-xs tabular-nums">{p.rate}%</span>
                    </div>
                  </td>
                  <td className="px-2 text-right tabular-nums text-emerald-300">{p.good.toLocaleString()}</td>
                  <td className="px-2 text-right tabular-nums text-amber-300">{p.partial.toLocaleString()}</td>
                  <td className="px-2 text-right tabular-nums text-rose-300">{p.missing.toLocaleString()}</td>
                  <td className="px-2 text-right tabular-nums text-orange-300">{p.leave.toLocaleString()}</td>
                  <td className="px-5 text-right tabular-nums text-muted">{hm(p.avgSecondsPerPresentDay)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="space-y-2 p-5">
            {Array.from({ length: 5 }, (_, k) => (
              <Skeleton key={k} className="h-9" />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
