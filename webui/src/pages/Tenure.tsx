import { useEffect, useMemo, useState } from "react";
import { useHr, useHrPost } from "../lib/hr";
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, PageHeader, Skeleton, Stat, StatStrip } from "../components/ui";
import { navigate } from "../lib/router";

interface TenureRow {
  userId: string;
  username: string;
  name: string;
  email: string;
  phone: string;
  handoverDone: boolean;
  handoverDate: string | null;
  project: string | null;
  moduleNum: number | null;
  podNum: number | null;
  submittedAt: string;
}

const place = (r: TenureRow) =>
  [r.project, r.moduleNum ? `M${r.moduleNum}` : null, r.podNum ? `P${r.podNum}` : null].filter(Boolean).join(" · ") || "—";

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * Interns who pressed "Tenure Completed" on the EMS access announcement in Discord.
 * The list holds email and phone, so it loads only after HR verification.
 */
export function TenurePage() {
  const { session } = useHr();
  const hp = useHrPost();
  const [rows, setRows] = useState<TenureRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");

  const load = async () => {
    setError(null);
    setLoading(true);
    try {
      setRows(await hp<TenureRow[]>("/api/tenure/list", {}, "View tenure completed list"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // Already verified as HR this tab: load straight away.
  useEffect(() => {
    if (session && rows === null && !loading) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const shown = useMemo(() => {
    const all = rows ?? [];
    const s = q.trim().toLowerCase();
    if (!s) return all;
    return all.filter((r) => [r.name, r.username, r.email, r.phone, r.project ?? ""].some((v) => v.toLowerCase().includes(s)));
  }, [rows, q]);

  const done = (rows ?? []).filter((r) => r.handoverDone).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tenure completed"
        description="Interns who pressed Tenure Completed on the EMS access announcement in Discord. They don't need EMS access."
      />
      {error ? <ErrorNote message={error} /> : null}

      {rows === null ? (
        <Card>
          <div className="flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted">This list includes email addresses and phone numbers. Verify as HR to view it.</p>
            <Button variant="primary" disabled={loading} onClick={load}>
              {loading ? "Loading…" : "Verify and view"}
            </Button>
          </div>
        </Card>
      ) : (
        <>
          <StatStrip cols={3}>
            <Stat label="Submitted" value={rows.length} tone="info" />
            <Stat label="Handover done" value={done} tone="good" />
            <Stat label="Handover pending" value={rows.length - done} tone={rows.length - done ? "warn" : undefined} />
          </StatStrip>

          <Card className="min-w-0">
            <CardHeader
              title="Submissions"
              subtitle="Latest first"
              action={
                <div className="flex items-center gap-2">
                  <Button onClick={load} disabled={loading}>
                    {loading ? "Refreshing…" : "Refresh"}
                  </Button>
                </div>
              }
            />
            <div className="px-5 pt-3">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search name, username, email, phone, project"
                className="h-9 w-full rounded-full border border-line-strong bg-panel px-3.5 text-sm text-fg outline-none placeholder:text-dim sm:max-w-sm"
              />
            </div>
            <div className="mt-3 border-t border-line">
              {loading && !rows.length ? (
                <div className="space-y-2 p-5">
                  {Array.from({ length: 4 }, (_, k) => (
                    <Skeleton key={k} className="h-10" />
                  ))}
                </div>
              ) : shown.length === 0 ? (
                <Empty>{rows.length ? "No one matches that search." : "No submissions yet."}</Empty>
              ) : (
                <div className="scroll-thin overflow-x-auto">
                  <table className="w-full min-w-[820px] text-left text-sm">
                    <thead className="text-[11px] tracking-[0.08em] text-dim uppercase">
                      <tr className="border-b border-line">
                        <th className="px-5 py-2.5 font-medium">Name</th>
                        <th className="px-3 py-2.5 font-medium">Contact</th>
                        <th className="px-3 py-2.5 font-medium">Project</th>
                        <th className="px-3 py-2.5 font-medium">Handover</th>
                        <th className="px-5 py-2.5 font-medium">Submitted</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line/60">
                      {shown.map((r) => (
                        <tr key={r.userId} className="align-top">
                          <td className="px-5 py-3">
                            <button
                              type="button"
                              onClick={() => navigate(`/member/${encodeURIComponent(r.userId)}`)}
                              className="text-left font-medium hover:underline"
                            >
                              {r.name}
                            </button>
                            <div className="text-xs text-dim">@{r.username}</div>
                          </td>
                          <td className="px-3 py-3">
                            <div className="break-all">{r.email}</div>
                            <div className="text-xs text-dim tabular-nums">{r.phone}</div>
                          </td>
                          <td className="px-3 py-3 text-muted">{place(r)}</td>
                          <td className="px-3 py-3">
                            <Badge tone={r.handoverDone ? "good" : "warn"} dot>
                              {r.handoverDone ? "Done" : "Not done"}
                            </Badge>
                            {r.handoverDate ? <div className="mt-1 text-xs text-dim tabular-nums">{r.handoverDate}</div> : null}
                          </td>
                          <td className="px-5 py-3 text-xs text-muted whitespace-nowrap">{when(r.submittedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
