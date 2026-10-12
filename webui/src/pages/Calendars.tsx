import { Button, Card } from "@heroui/react";
import { useMemo } from "react";
import {
  expandCalendar,
  get,
  monthLabel,
  scopeQuery,
  shiftMonth,
  type CompactCalendar,
  type Scope,
} from "../api";
import { useAsync } from "../lib/useAsync";
import { GroupCalendar } from "../components/GroupCalendar";
import { Legend } from "../components/status";
import { StatCard, StatGrid } from "../components/StatCard";

/**
 * The group calendar view. It is the same component for batch / project /
 * module / pod — the grouping is whatever the filter bar is set to, which keeps
 * one code path instead of four near-identical screens.
 */
export function CalendarsPage({
  scope,
  month,
  onMonth,
  minMonth,
}: {
  scope: Scope;
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

  const members = useMemo(
    () => (data ? data.members.map((c) => expandCalendar(c, data.days)) : []),
    [data]
  );
  const totals = members.reduce(
    (a, m) => ({
      good: a.good + m.totals.good,
      partial: a.partial + m.totals.partial,
      missing: a.missing + m.totals.missing,
      leave: a.leave + m.totals.leave,
    }),
    { good: 0, partial: 0, missing: 0, leave: 0 }
  );

  const scopeLabel =
    [
      scope.batch,
      scope.project,
      scope.module !== undefined ? `Module ${scope.module}` : null,
      scope.pod !== undefined ? `Pod ${scope.pod}` : null,
    ]
      .filter(Boolean)
      .join(" · ") || "Whole organization";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{scopeLabel}</h2>
          <p className="text-xs text-muted-foreground">
            {members.length} member(s) · {monthLabel(month)}
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
        <StatCard label="Completed days" value={totals.good} accent="success" />
        <StatCard label="Partial days" value={totals.partial} accent="warning" />
        <StatCard label="Missing days" value={totals.missing} accent="danger" />
        <StatCard label="Leave days" value={totals.leave} />
      </StatGrid>

      <Legend />

      <Card className="overflow-hidden p-0">
        {error ? (
          <p className="p-6 text-sm text-rose-400">Error: {error}</p>
        ) : loading && members.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <GroupCalendar members={members} />
        )}
      </Card>
    </div>
  );
}
