import { useMemo, useState } from "react";
import { ago, dayLabel, get, hm, timeOf, type ComplianceReport, type FilterOptions, type Scope } from "../api";
import { useAsync } from "../lib/useAsync";
import { navigate } from "../lib/router";
import { StatusChip, VIOLATION_STATUSES } from "../components/status";
import { FilterBar } from "../components/FilterBar";
import { Avatar, Badge, Card, Empty, ErrorNote, PageHeader, Segmented, Skeleton, Stat, StatStrip, cx } from "../components/ui";

type View = "all" | "violations" | "good" | "live";
type SortKey = "name" | "served" | "first" | "status";

/** Client-side scope match — /api/compliance returns the whole guild. */
function inScope(r: ComplianceReport["rows"][number], scope: Scope): boolean {
  if (scope.batch && r.batch !== scope.batch) return false;
  if (scope.project && r.project !== scope.project) return false;
  if (scope.module !== undefined && r.module !== scope.module) return false;
  if (scope.pod !== undefined && r.pod !== scope.pod) return false;
  if (scope.q) {
    const q = scope.q.toLowerCase();
    const hay = [r.fullName, r.project, r.batch].filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

const STATUS_ORDER: Record<string, number> = {
  absent: 0,
  "late-and-short": 1,
  "short-hours": 2,
  "late-login": 3,
  "not-joined-yet": 4,
  "in-progress": 5,
  compliant: 6,
  "off-day": 7,
  untracked: 8,
};

export function MembersPage({
  scope,
  onScope,
  filters,
  day,
  onDay,
}: {
  scope: Scope;
  onScope: (s: Scope) => void;
  filters: FilterOptions | null;
  day: string;
  onDay: (d: string) => void;
}) {
  const { data, error, loading } = useAsync(() => get<ComplianceReport>(`/api/compliance?day=${day}`), [day]);
  const [view, setView] = useState<View>("all");
  const [sort, setSort] = useState<SortKey>("status");

  const scoped = useMemo(() => (data?.rows ?? []).filter((r) => inScope(r, scope)), [data, scope]);
  const tally = { good: 0, breach: 0, live: 0, absent: 0, late: 0, short: 0 };
  for (const r of scoped) {
    if (r.status === "compliant") tally.good++;
    if (VIOLATION_STATUSES.includes(r.status)) tally.breach++;
    if (r.status === "absent") tally.absent++;
    if (r.status === "late-login" || r.status === "late-and-short") tally.late++;
    if (r.status === "short-hours" || r.status === "late-and-short") tally.short++;
    if (r.live) tally.live++;
  }
  const rows = scoped
    .filter((r) =>
      view === "all" ? true : view === "violations" ? VIOLATION_STATUSES.includes(r.status) : view === "good" ? r.status === "compliant" : r.live
    )
    .sort((a, b) =>
      sort === "name"
        ? a.fullName.localeCompare(b.fullName)
        : sort === "served"
          ? b.seconds - a.seconds
          : sort === "first"
            ? (a.firstJoinAt ?? "~").localeCompare(b.firstJoinAt ?? "~")
            : (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.fullName.localeCompare(b.fullName)
    );

  const Th = ({ k, label, right }: { k: SortKey; label: string; right?: boolean }) => (
    <th className={cx("px-3 py-2.5 font-medium", right && "text-right")}>
      <button type="button" onClick={() => setSort(k)} className={cx("uppercase tracking-[0.06em] hover:text-fg", sort === k && "text-fg")}>
        {label}
        {sort === k ? " ↓" : ""}
      </button>
    </th>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Members"
        description={data ? `${dayLabel(data.day, { weekday: "long", day: "numeric", month: "long", year: "numeric" })} · join by ${data.policy.loginBy}, serve ${data.policy.minHours}h` : "Daily rule compliance per member"}
        action={
          <input
            type="date"
            value={day}
            onChange={(e) => onDay(e.target.value)}
            className="h-9 rounded-full border border-line-strong bg-panel px-3.5 text-sm text-fg [color-scheme:dark]"
          />
        }
      />

      <FilterBar options={filters} scope={scope} onChange={onScope} />

      {error ? <ErrorNote message={error} /> : null}

      <StatStrip cols={6}>
        <Stat label="Following rules" value={tally.good} tone="good" hint={scoped.length ? `${Math.round((tally.good / scoped.length) * 100)}% of shown` : " "} />
        <Stat label="Breaking rules" value={tally.breach} tone={tally.breach ? "bad" : undefined} hint="late, short or absent" />
        <Stat label="Absent" value={tally.absent} tone={tally.absent ? "bad" : undefined} hint="no voice presence" />
        <Stat label="Late logins" value={tally.late} tone={tally.late ? "warn" : undefined} hint={data ? `after ${data.policy.loginBy}` : " "} />
        <Stat label="Short hours" value={tally.short} tone={tally.short ? "warn" : undefined} hint={data ? `under ${data.policy.minHours}h` : " "} />
        <Stat label="In voice now" value={tally.live} tone="info" hint={`${scoped.length} of ${data?.rows.length ?? 0} shown`} />
      </StatStrip>

      {data && !data.workday ? (
        <div className="rounded-2xl border border-line bg-panel px-5 py-3 text-sm text-muted">
          {dayLabel(data.day, { weekday: "long", day: "numeric", month: "long" })} is not a working day — nobody is held to the rules.
        </div>
      ) : null}

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: "all", label: `All ${scoped.length}` },
              { value: "violations", label: `Violations ${tally.breach}` },
              { value: "good", label: `Compliant ${tally.good}` },
              { value: "live", label: `Live ${tally.live}` },
            ]}
          />
          <span className="text-xs text-dim">Click a member to open their full profile</span>
        </div>
        <div className="scroll-thin max-h-[70vh] overflow-auto">
          {loading && !data ? (
            <div className="space-y-2 p-5">
              {Array.from({ length: 10 }, (_, k) => (
                <Skeleton key={k} className="h-10" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <Empty>No members match these filters.</Empty>
          ) : (
            <table className="w-full min-w-[820px] text-sm">
              <thead className="sticky top-0 z-10 bg-panel">
                <tr className="border-b border-line text-left text-[11px] text-dim">
                  <th className="px-5 py-2.5 font-medium">
                    <button type="button" onClick={() => setSort("name")} className={cx("uppercase tracking-[0.06em] hover:text-fg", sort === "name" && "text-fg")}>
                      Member{sort === "name" ? " ↓" : ""}
                    </button>
                  </th>
                  <th className="px-3 py-2.5 font-medium tracking-[0.06em] whitespace-nowrap uppercase">M / P</th>
                  <Th k="first" label="First join" />
                  <Th k="served" label="Served" />
                  <th className="px-3 py-2.5 font-medium tracking-[0.06em] uppercase">Last activity</th>
                  <Th k="status" label="Status" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const pctServed = r.requiredSeconds ? Math.min(100, (r.seconds / r.requiredSeconds) * 100) : 0;
                  return (
                    <tr
                      key={r.userId}
                      onClick={() => navigate(`/member/${encodeURIComponent(r.userId)}`)}
                      className="cursor-pointer border-b border-line/60 transition-colors hover:bg-white/[0.03]"
                    >
                      <td className="px-5 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={r.fullName} size={30} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 truncate font-medium">
                              {r.fullName}
                              {r.live ? <Badge tone="good" dot>live</Badge> : null}
                            </div>
                            <div className="truncate text-xs text-dim">{[r.project ?? "No project", r.batch].filter(Boolean).join(" · ")}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 whitespace-nowrap tabular-nums text-muted">
                        {r.module ?? "–"} / {r.pod ?? "–"}
                      </td>
                      <td className="px-3 tabular-nums">
                        <span className={cx(r.firstJoinAt && !r.loginOnTime && "text-amber-300")}>{timeOf(r.firstJoinAt)}</span>
                        {r.firstJoinAt && !r.loginOnTime ? <span className="ml-1.5 text-[11px] text-amber-300/80">late</span> : null}
                      </td>
                      <td className="px-3">
                        <div className="flex items-center gap-2.5">
                          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-white/[0.06]">
                            <div className={cx("h-full rounded-full", r.metHours ? "bg-emerald-400" : "bg-amber-400")} style={{ width: `${pctServed}%` }} />
                          </div>
                          <span className="tabular-nums">
                            {hm(r.seconds)}
                            <span className="text-dim"> / {hm(r.requiredSeconds)}</span>
                          </span>
                        </div>
                      </td>
                      <td className="px-3 text-muted">
                        <span title={r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString() : ""}>{ago(r.lastSeenAt)}</span>
                      </td>
                      <td className="px-3">
                        <StatusChip status={r.status} />
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
  );
}
