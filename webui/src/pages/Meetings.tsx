import { Card, Chip, Table } from "@heroui/react";
import { get, type MeetingRow } from "../api";
import { useAsync } from "../lib/useAsync";

const COLUMNS = [
  { id: "id", label: "#" },
  { id: "title", label: "Title" },
  { id: "start", label: "Start" },
  { id: "duration", label: "Duration" },
  { id: "status", label: "Status" },
  { id: "counts", label: "Present / Late / Absent / Excused" },
];

export function MeetingsPage() {
  const { data, error, loading } = useAsync(() => get<MeetingRow[]>("/api/meetings"), []);
  if (error) return <p className="text-sm text-rose-400">Error: {error}</p>;

  return (
    <Card className="overflow-hidden p-0">
      <Table aria-label="Meetings">
        <Table.ScrollContainer className="max-h-[75vh]">
          <Table.Content>
            <Table.Header columns={COLUMNS}>
              {(c) => <Table.Column isRowHeader={c.id === "title"}>{c.label}</Table.Column>}
            </Table.Header>
            <Table.Body
              items={data ?? []}
              renderEmptyState={() => (
                <div className="p-6 text-sm text-muted-foreground">
                  {loading ? "Loading…" : "No meetings yet."}
                </div>
              )}
            >
              {(m) => (
                <Table.Row id={m.id}>
                  <Table.Cell className="tabular-nums text-muted-foreground">{m.id}</Table.Cell>
                  <Table.Cell className="font-medium">{m.title}</Table.Cell>
                  <Table.Cell className="tabular-nums">
                    {new Date(m.startAt).toLocaleString()}
                  </Table.Cell>
                  <Table.Cell className="tabular-nums">{m.durationMin}m</Table.Cell>
                  <Table.Cell>
                    <Chip size="sm" variant="soft">
                      {m.status}
                    </Chip>
                  </Table.Cell>
                  <Table.Cell className="tabular-nums">
                    <span className="text-emerald-400">{m.counts.present ?? 0}</span>
                    {" / "}
                    <span className="text-amber-400">{m.counts.late ?? 0}</span>
                    {" / "}
                    <span className="text-rose-400">{m.counts.absent ?? 0}</span>
                    {" / "}
                    <span className="text-muted-foreground">{m.counts.excused ?? 0}</span>
                  </Table.Cell>
                </Table.Row>
              )}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
    </Card>
  );
}
