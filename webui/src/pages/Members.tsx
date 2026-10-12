import { Card, Chip, Table } from "@heroui/react";
import { ago, get, hm, timeOf, type ComplianceReport, type Scope } from "../api";
import { useAsync } from "../lib/useAsync";
import { navigate } from "../lib/router";
import { StatusChip } from "../components/status";
import { StatCard, StatGrid } from "../components/StatCard";

const COLUMNS = [
  { id: "member", label: "Member" },
  { id: "project", label: "Project" },
  { id: "mp", label: "M/P" },
  { id: "first", label: "First join" },
  { id: "served", label: "Served" },
  { id: "last", label: "Last activity" },
  { id: "status", label: "Status" },
];

/** Client-side scope match — /api/compliance returns the whole guild. */
function inScope(
  r: ComplianceReport["rows"][number],
  scope: Scope
): boolean {
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

export function MembersPage({ scope, day, onDay }: { scope: Scope; day: string; onDay: (d: string) => void }) {
  const { data, error, loading } = useAsync(
    () => get<ComplianceReport>(`/api/compliance?day=${day}`),
    [day]
  );

  if (error) return <p className="text-sm text-rose-400">Error: {error}</p>;

  const rows = (data?.rows ?? []).filter((r) => inScope(r, scope));
  const tally = { good: 0, breach: 0, live: 0 };
  for (const r of rows) {
    if (r.status === "compliant") tally.good++;
    if (["late-login", "short-hours", "late-and-short", "absent"].includes(r.status)) tally.breach++;
    if (r.live) tally.live++;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StatGrid>
          <StatCard label="Following rules" value={tally.good} accent="success" />
          <StatCard label="Breaking rules" value={tally.breach} accent="danger" />
          <StatCard label="In voice now" value={tally.live} />
          <StatCard label="Shown" value={rows.length} hint={`of ${data?.rows.length ?? 0}`} />
        </StatGrid>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Day
          <input
            type="date"
            value={day}
            onChange={(e) => onDay(e.target.value)}
            className="rounded-md border border-default bg-content1 px-2 py-1 text-sm text-foreground"
          />
        </label>
      </div>

      {data && !data.workday ? (
        <p className="text-sm text-muted-foreground">
          {data.day} is not a working day — everyone is marked off-day.
        </p>
      ) : null}

      <Card className="overflow-hidden p-0">
        <Table aria-label="Member compliance">
          <Table.ScrollContainer className="max-h-[70vh]">
            <Table.Content>
              <Table.Header columns={COLUMNS}>
                {(c) => <Table.Column isRowHeader={c.id === "member"}>{c.label}</Table.Column>}
              </Table.Header>
              <Table.Body
                items={rows}
                renderEmptyState={() => (
                  <div className="p-6 text-sm text-muted-foreground">
                    {loading ? "Loading…" : "No members match these filters."}
                  </div>
                )}
              >
                {(r) => (
                  <Table.Row
                    id={r.userId}
                    onAction={() => navigate(`/member/${encodeURIComponent(r.userId)}`)}
                    className="cursor-pointer"
                  >
                    <Table.Cell>
                      <span className="font-medium hover:text-indigo-400 hover:underline">
                        {r.fullName}
                      </span>
                      {r.live ? (
                        <Chip className="ml-2" color="success" size="sm" variant="soft">
                          live
                        </Chip>
                      ) : null}
                    </Table.Cell>
                    <Table.Cell>{r.project ?? "—"}</Table.Cell>
                    <Table.Cell className="tabular-nums">
                      {r.module ?? "?"}/{r.pod ?? "?"}
                    </Table.Cell>
                    <Table.Cell className="tabular-nums">
                      {timeOf(r.firstJoinAt)}
                      {r.firstJoinAt && !r.loginOnTime ? (
                        <Chip className="ml-1.5" color="warning" size="sm" variant="soft">
                          late
                        </Chip>
                      ) : null}
                    </Table.Cell>
                    <Table.Cell className="tabular-nums">
                      {hm(r.seconds)}
                      <span className="text-muted-foreground"> / {hm(r.requiredSeconds)}</span>
                    </Table.Cell>
                    <Table.Cell>
                      <span title={r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString() : ""}>
                        {ago(r.lastSeenAt)}
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      <StatusChip status={r.status} />
                    </Table.Cell>
                  </Table.Row>
                )}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      </Card>
    </div>
  );
}
