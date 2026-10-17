import { useMemo } from "react";
import { expandCalendar, get, monthLabel, scopeQuery, shiftMonth, type CompactCalendar, type FilterOptions, type Scope } from "../api";
import { useAsync } from "../lib/useAsync";
import { GroupCalendar } from "../components/GroupCalendar";
import { FilterBar } from "../components/FilterBar";
import { Legend } from "../components/status";
import { Button, Card, ErrorNote, PageHeader, Skeleton, Stat, StatStrip, rateTone } from "../components/ui";

/**
 * The group calendar view. It is the same component for batch / project /
 * module / pod — the grouping is whatever the filter bar is set to, which keeps
 * one code path instead of four near-identical screens.
 */
export function CalendarsPage({
  scope,
  onScope,
  filters,
  month,
  onMonth,
  minMonth,
}: {
  scope: Scope;
  onScope: (s: Scope) => void;
  filters: FilterOptions | null;
  month: string;
  onMonth: (m: string) => void;
  minMonth: string | null;
}) {
  const atStart = Boolean(minMonth && month <= minMonth);
  const query = scopeQuery(scope);
  const { data, error, loading } = useAsync(
    () =>
      get<{ from: string; to: string; days: string[]; members: CompactCalendar[] }>(
        `/api/calendar?month=${month}${query ? `&${query}` : ""}`
      ),
    [month, query]
  );

  const members = useMemo(() => (data ? data.members.map((c) => expandCalendar(c, data.days)) : []), [data]);
  const totals = members.reduce(
    (a, m) => ({
      good: a.good + m.totals.good,
      partial: a.partial + m.totals.partial,
      missing: a.missing + m.totals.missing,
      leave: a.leave + m.totals.leave,
    }),
    { good: 0, partial: 0, missing: 0, leave: 0 }
  );
  const settled = totals.good + totals.partial + totals.missing;
  const rate = settled ? Math.round((totals.good / settled) * 1000) / 10 : 0;

  const scopeLabel =
    [scope.batch, scope.project, scope.module !== undefined ? `Module ${scope.module}` : null, scope.pod !== undefined ? `Pod ${scope.pod}` : null]
      .filter(Boolean)
      .join(" · ") || "Whole organization";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Calendars"
        description={`${scopeLabel} · ${members.length} member${members.length === 1 ? "" : "s"} · ${monthLabel(month)}`}
        action={
          <div className="flex items-center gap-1.5">
            <Button size="sm" disabled={atStart} onClick={() => onMonth(shiftMonth(month, -1))}>
              ←
            </Button>
            <span className="min-w-[9.5rem] text-center text-sm font-medium">{monthLabel(month)}</span>
            <Button size="sm" onClick={() => onMonth(shiftMonth(month, 1))}>
              →
            </Button>
          </div>
        }
      />

      <FilterBar options={filters} scope={scope} onChange={onScope} />

      <StatStrip cols={5}>
        <Stat label="Compliance" value={`${rate}%`} tone={settled ? rateTone(rate) : undefined} hint={`${settled.toLocaleString()} member-days`} />
        <Stat label="Completed" value={totals.good.toLocaleString()} tone="good" />
        <Stat label="Partial" value={totals.partial.toLocaleString()} tone="warn" hint="late and/or short" />
        <Stat label="Absent" value={totals.missing.toLocaleString()} tone="bad" />
        <Stat label="Leave" value={totals.leave.toLocaleString()} tone="leave" />
      </StatStrip>

      <Legend />

      <Card className="overflow-hidden">
        {error ? (
          <div className="p-5">
            <ErrorNote message={error} />
          </div>
        ) : loading && members.length === 0 ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 10 }, (_, k) => (
              <Skeleton key={k} className="h-6" />
            ))}
          </div>
        ) : (
          <GroupCalendar members={members} />
        )}
      </Card>
    </div>
  );
}
