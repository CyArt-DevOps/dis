import { useEffect, useMemo, useState } from "react";
import { dateOf, dayLabel, get, post, type WarningRow, type WarningsData } from "../api";
import { useAsync } from "../lib/useAsync";
import { navigate } from "../lib/router";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  PageHeader,
  Segmented,
  Select,
  Skeleton,
  Stat,
  StatStrip,
  cx,
  type Tone,
} from "../components/ui";

type Tab = "queue" | "all" | "termination" | "issue";

const NAME_KEY = "dash.approvedBy";
function readName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}
function saveName(v: string) {
  try {
    localStorage.setItem(NAME_KEY, v.trim());
  } catch {
    /* not remembered */
  }
}

const STATUS: Record<string, { label: string; tone: Tone }> = {
  proposed: { label: "Awaiting review", tone: "info" },
  sent: { label: "Sent · awaiting ack", tone: "warn" },
  "dm-failed": { label: "DM failed", tone: "bad" },
  acknowledged: { label: "Acknowledged", tone: "good" },
  dismissed: { label: "Dismissed", tone: "neutral" },
};

function StatusBadge({ w }: { w: WarningRow }) {
  if (w.overdue) return <Badge tone="bad" dot>Ack overdue</Badge>;
  const s = STATUS[w.status] ?? { label: w.status, tone: "neutral" as Tone };
  return (
    <Badge tone={s.tone} dot>
      {s.label}
    </Badge>
  );
}

function Strikes({ n, limit }: { n: number; limit: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" title={`${n} of ${limit} warnings`}>
      {Array.from({ length: limit }, (_, k) => (
        <span key={k} className={cx("h-2.5 w-1.5 rounded-sm", k < n ? (n >= limit ? "bg-rose-400" : "bg-amber-400") : "bg-white/10")} />
      ))}
    </span>
  );
}

export function WarningsPage() {
  const { data, error, loading, reload } = useAsync(() => get<WarningsData>("/api/warnings"), []);
  const [tab, setTab] = useState<Tab>("queue");
  const [toast, setToast] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const flash = (tone: "good" | "bad", text: string) => {
    setToast({ tone, text });
    window.setTimeout(() => setToast(null), 7000);
  };

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    try {
      flash("good", await fn());
      reload();
    } catch (e) {
      flash("bad", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const w = data?.warnings ?? [];
  const queue = w.filter((x) => x.status === "proposed");
  const counts = {
    queue: queue.length,
    awaiting: w.filter((x) => x.status === "sent" && !x.overdue).length,
    overdue: w.filter((x) => x.overdue).length,
    acked: w.filter((x) => x.status === "acknowledged").length,
    failed: w.filter((x) => x.status === "dm-failed").length,
  };
  const limit = data?.strikeLimit ?? 3;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          data ? (
            <>
              <Badge tone={data.mode === "strict" ? "bad" : "info"}>{data.mode === "strict" ? "Strict mode" : "Review mode"}</Badge>
              {data.mode === "strict"
                ? "Warnings send and terminations run automatically"
                : "Automatic warnings wait for HR; terminations need a person"}
            </>
          ) : undefined
        }
        title="Warnings"
        description={
          data
            ? `Auto warning after ${data.consecutiveShortDays} consecutive working days under the hours target${data.startsOn ? ` (counting from ${dayLabel(data.startsOn, { day: "numeric", month: "short" })})` : ""} · acknowledge within ${data.ackHours}h · ${limit} warnings = termination`
            : "Formal warnings, acknowledgements and the three-strike rule"
        }
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                run("check", async () => {
                  const r = await post<{ checked: number; created: number }>("/api/warnings/run-check", {});
                  return `Checked ${r.checked} members · ${r.created} new warning${r.created === 1 ? "" : "s"} drafted`;
                })
              }
            >
              {busy === "check" ? "Checking…" : "Run check now"}
            </Button>
            <Button size="sm" variant="primary" onClick={() => setTab("issue")}>
              + Issue warning
            </Button>
          </div>
        }
      />

      {error ? <ErrorNote message={error} /> : null}
      {data && !data.botConnected ? (
        <div className="rounded-2xl border border-amber-400/25 bg-amber-400/5 px-5 py-3 text-sm text-amber-200">
          The bot isn't connected in this process (standalone dashboard), so warnings can be reviewed but not DMed and nobody can be removed.
        </div>
      ) : null}

      <StatStrip cols={6}>
        <Stat label="Awaiting review" value={counts.queue} tone="info" hint="drafted automatically" />
        <Stat label="Awaiting ack" value={counts.awaiting} tone={counts.awaiting ? "warn" : undefined} hint={`within ${data?.ackHours ?? 24}h`} />
        <Stat label="Ack overdue" value={counts.overdue} tone={counts.overdue ? "bad" : undefined} />
        <Stat label="Acknowledged" value={counts.acked} tone="good" />
        <Stat label="DM failed" value={counts.failed} tone={counts.failed ? "bad" : undefined} hint="DMs closed" />
        <Stat label="Termination review" value={data?.candidates.length ?? 0} tone={data?.candidates.length ? "bad" : undefined} hint={`${limit}+ warnings`} />
      </StatStrip>

      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: "queue", label: `Review queue ${counts.queue}` },
          { value: "all", label: `All warnings ${w.filter((x) => x.status !== "proposed").length}` },
          { value: "termination", label: `Termination ${data?.candidates.length ?? 0}` },
          { value: "issue", label: "Issue warning" },
        ]}
      />

      {loading && !data ? (
        <Skeleton className="h-96" />
      ) : tab === "queue" ? (
        <QueueTab
          rows={queue}
          limit={limit}
          busy={busy}
          canSend={Boolean(data?.botConnected)}
          onSend={(x) => run(`send-${x.id}`, async () => {
            const r = await post<{ status: string }>(`/api/warnings/${x.id}/send`, {});
            return r.status === "sent" ? `Warning DMed to ${x.fullName}` : `${x.fullName} has DMs closed; the warning is recorded`;
          })}
          onDismiss={(x) => run(`dismiss-${x.id}`, async () => {
            await post(`/api/warnings/${x.id}/dismiss`, {});
            return `Draft for ${x.fullName} dismissed`;
          })}
          onSendAll={() => run("send-all", async () => {
            const r = await post<{ queued: number }>("/api/warnings/send-all", {});
            return `Sending ${r.queued} warnings in the background (about ${Math.ceil((r.queued * 1.5) / 60)} min). Refresh to follow.`;
          })}
        />
      ) : tab === "all" ? (
        <AllTab rows={w.filter((x) => x.status !== "proposed")} limit={limit} busy={busy} canSend={Boolean(data?.botConnected)}
          onRetry={(x) => run(`send-${x.id}`, async () => {
            const r = await post<{ status: string }>(`/api/warnings/${x.id}/send`, {});
            return r.status === "sent" ? `Warning DMed to ${x.fullName}` : `Still couldn't DM ${x.fullName}`;
          })}
          onDismiss={(x) => run(`dismiss-${x.id}`, async () => {
            await post(`/api/warnings/${x.id}/dismiss`, {});
            return `Warning #${x.id} dismissed (no longer counts)`;
          })}
        />
      ) : tab === "termination" && data ? (
        <TerminationTab data={data} onDone={(t) => { flash(t.tone, t.text); reload(); }} />
      ) : (
        <IssueTab
          botConnected={Boolean(data?.botConnected)}
          onIssued={(text) => {
            flash("good", text);
            reload();
            setTab("all");
          }}
          onError={(text) => flash("bad", text)}
        />
      )}

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

function MemberCell({ x }: { x: { userId: string; fullName: string; project: string | null; batch: string | null } }) {
  return (
    <button type="button" onClick={() => navigate(`/member/${encodeURIComponent(x.userId)}`)} className="flex items-center gap-2.5 text-left">
      <Avatar name={x.fullName} size={28} />
      <span className="min-w-0">
        <span className="block truncate font-medium hover:underline">{x.fullName}</span>
        <span className="block truncate text-xs text-dim">{[x.project, x.batch].filter(Boolean).join(" · ") || "No project"}</span>
      </span>
    </button>
  );
}

function Reason({ text }: { text: string }) {
  const [head, ...rest] = text.split("\n");
  return (
    <div className="min-w-0">
      <div className="text-sm">{head}</div>
      {rest.length ? (
        <ul className="mt-1 space-y-0.5 text-xs text-dim">
          {rest.map((l, k) => (
            <li key={k}>{l}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function QueueTab({
  rows,
  limit,
  busy,
  canSend,
  onSend,
  onDismiss,
  onSendAll,
}: {
  rows: WarningRow[];
  limit: number;
  busy: string | null;
  canSend: boolean;
  onSend: (w: WarningRow) => void;
  onDismiss: (w: WarningRow) => void;
  onSendAll: () => void;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Drafted by the attendance check"
        subtitle="Review each one, then send it as a formal DM or dismiss it. Nothing here has reached the member yet."
        action={
          <Button size="sm" variant="primary" disabled={!rows.length || !canSend || busy !== null} onClick={() => {
            if (window.confirm(`Send all ${rows.length} drafted warnings as DMs?`)) onSendAll();
          }}>
            Send all {rows.length || ""}
          </Button>
        }
      />
      <div className="scroll-thin mt-4 max-h-[65vh] overflow-auto border-t border-line">
        {rows.length === 0 ? (
          <Empty>Nothing to review. The check runs every 30 minutes after the day's window closes.</Empty>
        ) : (
          <ul className="divide-y divide-line/60">
            {rows.map((x) => (
              <li key={x.id} className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(200px,1fr)_2fr_auto] md:items-start">
                <div className="flex items-center gap-3">
                  <MemberCell x={x} />
                </div>
                <div>
                  <Reason text={x.reason} />
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-dim">
                    <Badge tone="info">auto · {x.kind}</Badge>
                    <span>
                      would be warning <b className="text-fg">{x.strikes + 1}</b> of {limit}
                    </span>
                    <Strikes n={x.strikes + 1} limit={limit} />
                    {x.strikes + 1 >= limit ? <Badge tone="bad">reaches termination</Badge> : null}
                  </div>
                </div>
                <div className="flex gap-2 md:justify-end">
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => onDismiss(x)}>
                    Dismiss
                  </Button>
                  <Button size="sm" variant="primary" disabled={!canSend || busy !== null} onClick={() => onSend(x)}>
                    {busy === `send-${x.id}` ? "Sending…" : "Send DM"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function AllTab({
  rows,
  limit,
  busy,
  canSend,
  onRetry,
  onDismiss,
}: {
  rows: WarningRow[];
  limit: number;
  busy: string | null;
  canSend: boolean;
  onRetry: (w: WarningRow) => void;
  onDismiss: (w: WarningRow) => void;
}) {
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const shown = rows
    .filter((x) =>
      filter === "all" ? true : filter === "overdue" ? x.overdue : filter === "auto" ? x.source === "auto" : filter === "manual" ? x.source !== "auto" : x.status === filter
    )
    .filter((x) => !q || x.fullName.toLowerCase().includes(q.toLowerCase()));
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        <Select
          label="Filter"
          className="min-w-[11rem]"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All issued" },
            { value: "sent", label: "Awaiting ack" },
            { value: "overdue", label: "Ack overdue" },
            { value: "acknowledged", label: "Acknowledged" },
            { value: "dm-failed", label: "DM failed" },
            { value: "dismissed", label: "Dismissed" },
            { value: "auto", label: "Automatic" },
            { value: "manual", label: "Manual" },
          ]}
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find a member…"
          className="h-9 w-full rounded-full border border-line-strong bg-panel px-3.5 text-sm outline-none placeholder:text-dim sm:w-56"
        />
        <span className="ml-auto text-xs text-dim">{shown.length} shown</span>
      </div>
      <div className="scroll-thin max-h-[65vh] overflow-auto">
        {shown.length === 0 ? (
          <Empty>No warnings here.</Empty>
        ) : (
          <table className="w-full min-w-[900px] text-sm">
            <thead className="sticky top-0 z-10 bg-panel">
              <tr className="border-b border-line text-left text-[11px] tracking-[0.06em] text-dim uppercase">
                <th className="px-5 py-2.5 font-medium">Member</th>
                <th className="px-3 py-2.5 font-medium">Reason</th>
                <th className="px-3 py-2.5 font-medium">Issued</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Strikes</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {shown.map((x) => (
                <tr key={x.id} className="border-b border-line/60 align-top last:border-0">
                  <td className="px-5 py-3">
                    <MemberCell x={x} />
                  </td>
                  <td className="max-w-[360px] px-3 py-3">
                    <Reason text={x.reason} />
                  </td>
                  <td className="px-3 py-3 text-xs text-muted">
                    <div>{dateOf(x.sentAt ?? x.createdAt)}</div>
                    <div className="text-dim">
                      {x.source === "auto" ? "automatic" : `by ${x.issuedBy}`} · #{x.id}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <StatusBadge w={x} />
                    {x.acknowledgedAt ? <div className="mt-1 text-[11px] text-dim">{dateOf(x.acknowledgedAt)}</div> : null}
                    {x.status === "sent" && x.ackDueAt ? (
                      <div className="mt-1 text-[11px] text-dim">due {new Date(x.ackDueAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-3">
                    <Strikes n={x.strikes} limit={limit} />
                  </td>
                  <td className="px-5 py-3 text-right whitespace-nowrap">
                    {x.status === "dm-failed" && canSend ? (
                      <button type="button" disabled={busy !== null} onClick={() => onRetry(x)} className="mr-3 text-xs text-muted hover:text-fg">
                        retry DM
                      </button>
                    ) : null}
                    {x.status !== "dismissed" ? (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => window.confirm(`Dismiss warning #${x.id}? It will no longer count as a strike.`) && onDismiss(x)}
                        className="text-xs text-dim hover:text-rose-300"
                      >
                        dismiss
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Card>
  );
}

function TerminationTab({ data, onDone }: { data: WarningsData; onDone: (t: { tone: "good" | "bad"; text: string }) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [by, setBy] = useState(readName);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const terminate = async (userId: string, name: string) => {
    setBusy(true);
    try {
      saveName(by);
      const r = await post<{ kicked: boolean; error: string | null }>(`/api/members/${userId}/terminate`, { by, confirm });
      onDone(r.kicked ? { tone: "good", text: `${name} was notified and removed from the server.` } : { tone: "bad", text: `Recorded, but not removed: ${r.error}` });
      setOpen(null);
      setConfirm("");
    } catch (e) {
      onDone({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-5">
      <Card className="min-w-0 overflow-hidden xl:col-span-3">
        <CardHeader
          title="Up for termination"
          subtitle={`Members with ${data.strikeLimit} or more issued warnings. Removing someone DMs them a termination notice, then removes them from the server.`}
        />
        <div className="mt-4 border-t border-line">
          {data.candidates.length === 0 ? (
            <Empty>Nobody has reached {data.strikeLimit} warnings.</Empty>
          ) : (
            <ul className="divide-y divide-line/60">
              {data.candidates.map((c) => (
                <li key={c.userId} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <MemberCell x={c} />
                    <Strikes n={c.strikes} limit={data.strikeLimit} />
                    <span className="text-xs text-dim">{c.strikes} warnings</span>
                    <div className="ml-auto">
                      <Button size="sm" disabled={!data.botConnected} onClick={() => setOpen(open === c.userId ? null : c.userId)}>
                        {open === c.userId ? "Cancel" : "Terminate…"}
                      </Button>
                    </div>
                  </div>
                  {open === c.userId ? (
                    <div className="mt-3 grid gap-2 rounded-xl border border-rose-400/25 bg-rose-400/5 p-3 sm:grid-cols-[1fr_1fr_auto]">
                      <input
                        value={by}
                        onChange={(e) => setBy(e.target.value)}
                        placeholder="Your name"
                        className="h-9 rounded-full border border-line-strong bg-panel px-3.5 text-sm outline-none placeholder:text-dim"
                      />
                      <input
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                        placeholder="Type TERMINATE"
                        className="h-9 rounded-full border border-line-strong bg-panel px-3.5 text-sm outline-none placeholder:text-dim"
                      />
                      <button
                        type="button"
                        disabled={busy || confirm !== "TERMINATE" || by.trim().length < 2}
                        onClick={() => terminate(c.userId, c.fullName)}
                        className="h-9 rounded-full bg-rose-500 px-4 text-sm font-semibold text-white hover:bg-rose-400 disabled:opacity-40"
                      >
                        {busy ? "Removing…" : "Remove from server"}
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
      <Card className="min-w-0 xl:col-span-2">
        <CardHeader title="Termination log" subtitle="Everyone removed for non-compliance" action={<Badge>{data.terminations.length}</Badge>} />
        <div className="scroll-thin mt-3 max-h-[60vh] overflow-y-auto border-t border-line">
          {data.terminations.length === 0 ? (
            <Empty>No terminations yet.</Empty>
          ) : (
            <ul className="divide-y divide-line/60">
              {data.terminations.map((t) => (
                <li key={t.id} className="px-5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{t.fullName ?? t.userId}</span>
                    <Badge tone={t.kicked ? "bad" : "warn"}>{t.kicked ? "removed" : "not removed"}</Badge>
                  </div>
                  <div className="text-[11px] text-dim">
                    {dateOf(t.createdAt)} · by {t.by.replace(/^dashboard:/, "")}
                    {t.error ? ` · ${t.error}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}

function IssueTab({ botConnected, onIssued, onError }: { botConnected: boolean; onIssued: (t: string) => void; onError: (t: string) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ id: string; fullName: string; project: string | null; batch: string | null }[]>([]);
  const [picked, setPicked] = useState<{ id: string; fullName: string; project: string | null; batch: string | null } | null>(null);
  const [kind, setKind] = useState("conduct");
  const [reason, setReason] = useState("");
  const [by, setBy] = useState(readName);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (picked || q.trim().length < 2) {
      setResults([]);
      return;
    }
    const t = window.setTimeout(() => {
      void get<typeof results>(`/api/members/search?q=${encodeURIComponent(q.trim())}`).then(setResults).catch(() => setResults([]));
    }, 250);
    return () => window.clearTimeout(t);
  }, [q, picked]);

  const preview = useMemo(
    () => reason.trim() || "Write the reason the member will read in the DM.",
    [reason]
  );

  const submit = async () => {
    if (!picked) return onError("Pick a member.");
    setBusy(true);
    try {
      saveName(by);
      const r = await post<{ id: number; status: string }>("/api/warnings", { userId: picked.id, reason, kind, issuedBy: by });
      onIssued(
        r.status === "sent"
          ? `Warning #${r.id} DMed to ${picked.fullName}`
          : r.status === "dm-failed"
            ? `Warning #${r.id} recorded; ${picked.fullName} has DMs closed`
            : `Warning #${r.id} saved as a draft (bot not connected)`
      );
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="min-w-0">
        <CardHeader title="Issue a warning" subtitle={botConnected ? "Sent as a formal DM immediately, with a 24h acknowledgement." : "Bot not connected here: it will be saved as a draft."} />
        <div className="space-y-3 p-5">
          <div className="relative">
            <label className="block text-xs text-muted">Member</label>
            {picked ? (
              <div className="mt-1.5 flex items-center justify-between rounded-full border border-line-strong bg-panel py-1 pr-1 pl-2">
                <span className="flex items-center gap-2 text-sm">
                  <Avatar name={picked.fullName} size={24} />
                  {picked.fullName}
                  <span className="text-xs text-dim">{picked.project ?? ""}</span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => { setPicked(null); setQ(""); }}>
                  change
                </Button>
              </div>
            ) : (
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search by name or Discord tag…"
                className="mt-1.5 h-9 w-full rounded-full border border-line-strong bg-panel px-3.5 text-sm outline-none placeholder:text-dim"
              />
            )}
            {results.length && !picked ? (
              <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-line-strong bg-panel-2 py-1 shadow-2xl">
                {results.map((r) => (
                  <li key={r.id}>
                    <button type="button" onClick={() => setPicked(r)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/5">
                      <Avatar name={r.fullName} size={24} />
                      <span className="min-w-0 flex-1 truncate">{r.fullName}</span>
                      <span className="text-xs text-dim">{r.project ?? "No project"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <label className="block text-xs text-muted">
            Type
            <Select
              label="Type"
              className="mt-1.5"
              value={kind}
              onChange={setKind}
              options={[
                { value: "conduct", label: "Conduct" },
                { value: "hours", label: "Attendance / hours" },
                { value: "other", label: "Other" },
              ]}
            />
          </label>
          <label className="block text-xs text-muted">
            Reason
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={5}
              maxLength={1500}
              placeholder="Be specific: what happened, when, and what is expected."
              className="mt-1.5 w-full resize-none rounded-xl border border-line-strong bg-panel px-3 py-2 text-sm text-fg outline-none placeholder:text-dim"
            />
          </label>
          <label className="block text-xs text-muted">
            Issued by
            <input
              value={by}
              onChange={(e) => setBy(e.target.value)}
              maxLength={80}
              placeholder="Your name"
              className="mt-1.5 h-9 w-full rounded-full border border-line-strong bg-panel px-3.5 text-sm outline-none placeholder:text-dim"
            />
          </label>
          <Button variant="primary" className="w-full" disabled={busy || !picked || reason.trim().length < 5 || by.trim().length < 2} onClick={submit}>
            {busy ? "Sending…" : botConnected ? "Send formal warning" : "Save draft"}
          </Button>
        </div>
      </Card>
      <Card className="min-w-0">
        <CardHeader title="DM preview" subtitle="Roughly what the member receives" />
        <div className="p-5">
          <div className="rounded-xl border-l-4 border-orange-500 bg-panel-2 p-4 text-sm">
            <div className="font-semibold">Formal Warning{kind === "hours" ? ": Attendance Non-Compliance" : ""}</div>
            <p className="mt-2 text-muted">Dear {picked?.fullName ?? "Intern"},</p>
            <p className="mt-2 text-muted">This is formal warning <b className="text-fg">N of 3</b> issued to you by HR.</p>
            <p className="mt-2 font-medium">Reason</p>
            <p className="whitespace-pre-wrap text-muted">{preview}</p>
            <p className="mt-2 font-medium">Action required</p>
            <p className="text-muted">Press Acknowledge below within 24 hours.</p>
            <p className="mt-2 text-muted">Reaching 3 warnings results in termination of your internship and removal from the server.</p>
            <div className="mt-3 inline-flex rounded-md bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white">Acknowledge</div>
          </div>
        </div>
      </Card>
    </div>
  );
}
