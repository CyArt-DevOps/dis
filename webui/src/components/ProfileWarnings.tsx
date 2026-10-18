import { useState } from "react";
import { dateOf, dayLabel, get } from "../api";
import { useAsync } from "../lib/useAsync";
import { useHrPost } from "../lib/hr";
import { Badge, Button, Card, CardHeader, Empty, Select, Skeleton, cx, type Tone } from "./ui";

interface Note {
  id: number;
  author: string;
  body: string;
  kind: string;
  notified: boolean;
  createdAt: string;
}

interface MemberWarning {
  id: number;
  source: string;
  kind: string;
  status: string;
  reason: string;
  days: string[];
  issuedBy: string;
  reviewedBy: string | null;
  createdAt: string;
  sentAt: string | null;
  ackDueAt: string | null;
  acknowledgedAt: string | null;
  overdue: boolean;
  strikeNumber: number | null;
  notes: Note[];
}

interface MemberWarnings {
  strikes: number;
  strikeLimit: number;
  botConnected: boolean;
  warnings: MemberWarning[];
}

const STATUS: Record<string, { label: string; tone: Tone }> = {
  proposed: { label: "Draft · awaiting review", tone: "info" },
  sent: { label: "Sent · awaiting ack", tone: "warn" },
  "dm-failed": { label: "DM failed", tone: "bad" },
  acknowledged: { label: "Acknowledged", tone: "good" },
  dismissed: { label: "Dismissed draft", tone: "neutral" },
  revoked: { label: "Revoked", tone: "neutral" },
};

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * Every warning a member has, on their profile: status, acknowledgement and
 * HR notes, with sign-off actions to add details, revoke, or issue a new one.
 */
export function ProfileWarnings({ userId, name }: { userId: string; name: string }) {
  const { data, loading, reload } = useAsync(
    () => get<MemberWarnings>(`/api/profile/${encodeURIComponent(userId)}/warnings`),
    [userId]
  );
  const hp = useHrPost();
  const [mode, setMode] = useState<{ id: number; type: "note" | "revoke" } | null>(null);
  const [text, setText] = useState("");
  const [notify, setNotify] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [kind, setKind] = useState("conduct");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "good" | "bad"; text: string } | null>(null);

  const done = (tone: "good" | "bad", t: string) => {
    setMsg({ tone, text: t });
    window.setTimeout(() => setMsg(null), 7000);
  };

  const submit = async (w: MemberWarning) => {
    if (!mode) return;
    setBusy(true);
    try {
      if (mode.type === "revoke") {
        const r = await hp<{ notified: boolean }>(`/api/warnings/${w.id}/revoke`, { reason: text }, `Revoke warning #${w.id} for ${name}`);
        done("good", `Warning #${w.id} ${w.status === "proposed" ? "dismissed" : "revoked"}${r.notified ? "; member notified by DM" : ""}.`);
      } else {
        const r = await hp<{ notified: boolean }>(`/api/warnings/${w.id}/notes`, { body: text, notify }, `Add details to warning #${w.id}`);
        done("good", `Details added to warning #${w.id}${r.notified ? " and sent to the member" : ""}.`);
      }
      setMode(null);
      setText("");
      setNotify(false);
      reload();
    } catch (e) {
      done("bad", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const issue = async () => {
    setBusy(true);
    try {
      const r = await hp<{ id: number; status: string }>("/api/warnings", { userId, reason: text, kind }, `Issue a warning to ${name}`);
      done(
        "good",
        r.status === "sent"
          ? `Warning #${r.id} DMed to ${name}.`
          : r.status === "dm-failed"
            ? `Warning #${r.id} recorded; ${name} has DMs closed.`
            : `Warning #${r.id} saved as a draft.`
      );
      setIssuing(false);
      setText("");
      reload();
    } catch (e) {
      done("bad", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const limit = data?.strikeLimit ?? 3;
  const strikes = data?.strikes ?? 0;

  return (
    <Card className="min-w-0">
      <CardHeader
        title="Warnings"
        subtitle="Every warning on record. Revoked and dismissed ones no longer count. Actions need HR sign-off."
        action={
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 text-xs text-dim" title={`${strikes} of ${limit} strikes`}>
              {Array.from({ length: limit }, (_, k) => (
                <span key={k} className={cx("h-3 w-1.5 rounded-sm", k < strikes ? (strikes >= limit ? "bg-rose-400" : "bg-amber-400") : "bg-white/10")} />
              ))}
              <b className="font-medium text-fg">{strikes}</b>/{limit}
            </span>
            <Button size="sm" variant="primary" onClick={() => { setIssuing((v) => !v); setMode(null); setText(""); }}>
              {issuing ? "Cancel" : "+ Issue warning"}
            </Button>
          </div>
        }
      />

      {msg ? (
        <p className={cx("mx-5 mt-4 rounded-lg border px-3 py-2 text-xs", msg.tone === "good" ? "border-emerald-400/25 bg-emerald-400/5 text-emerald-300" : "border-rose-400/25 bg-rose-400/5 text-rose-300")}>
          {msg.text}
        </p>
      ) : null}

      {issuing ? (
        <div className="mx-5 mt-4 space-y-3 rounded-xl border border-line-strong bg-panel-2 p-4">
          <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
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
              Reason (the member reads this in the DM)
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                maxLength={1500}
                placeholder="What happened, when, and what is expected."
                className="mt-1.5 w-full resize-none rounded-xl border border-line-strong bg-panel px-3 py-2 text-sm outline-none placeholder:text-dim"
              />
            </label>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-dim">
              This would be warning {strikes + 1} of {limit}
              {strikes + 1 >= limit ? ", which puts the member up for termination" : ""}.
            </span>
            <Button variant="primary" size="sm" disabled={busy || text.trim().length < 5} onClick={issue}>
              {busy ? "Sending…" : data?.botConnected ? "Send formal warning" : "Save draft"}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-4 border-t border-line">
        {loading && !data ? (
          <div className="space-y-2 p-5">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
        ) : !data?.warnings.length ? (
          <Empty>No warnings on record.</Empty>
        ) : (
          <ul className="divide-y divide-line/60">
            {data.warnings.map((w) => {
              const s = w.overdue ? { label: "Ack overdue", tone: "bad" as Tone } : STATUS[w.status] ?? { label: w.status, tone: "neutral" as Tone };
              const withdrawn = w.status === "revoked" || w.status === "dismissed";
              const [head, ...lines] = w.reason.split("\n");
              return (
                <li key={w.id} className={cx("px-5 py-4", withdrawn && "opacity-70")}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold tabular-nums">#{w.id}</span>
                    {w.strikeNumber ? <Badge tone={w.strikeNumber >= limit ? "bad" : "warn"}>Strike {w.strikeNumber} of {limit}</Badge> : null}
                    <Badge tone={s.tone} dot>
                      {s.label}
                    </Badge>
                    <Badge>{w.source === "auto" ? "automatic" : w.source} · {w.kind}</Badge>
                    <span className="ml-auto text-[11px] text-dim">{when(w.sentAt ?? w.createdAt)}</span>
                  </div>

                  <div className={cx("mt-2 text-sm", withdrawn && "line-through decoration-white/30")}>{head}</div>
                  {lines.length ? (
                    <ul className="mt-1 space-y-0.5 text-xs text-dim">
                      {lines.map((l, k) => (
                        <li key={k}>{l}</li>
                      ))}
                    </ul>
                  ) : null}
                  {w.days.length ? (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {w.days.map((d) => (
                        <Badge key={d} tone="neutral">
                          {dayLabel(d, { weekday: "short", day: "numeric", month: "short" })}
                        </Badge>
                      ))}
                    </div>
                  ) : null}

                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-dim">
                    <span>Issued by {w.issuedBy}</span>
                    {w.reviewedBy ? <span>{withdrawn ? "Withdrawn" : "Sent"} by {w.reviewedBy}</span> : null}
                    {w.acknowledgedAt ? <span className="text-emerald-300/80">Acknowledged {dateOf(w.acknowledgedAt)}</span> : null}
                    {w.status === "sent" && w.ackDueAt ? <span className={w.overdue ? "text-rose-300" : ""}>Ack due {when(w.ackDueAt)}</span> : null}
                  </div>

                  {w.notes.length ? (
                    <ol className="mt-3 space-y-2 border-l border-line pl-3">
                      {w.notes.map((n) => (
                        <li key={n.id} className="text-xs">
                          <div className="flex flex-wrap items-center gap-2 text-dim">
                            <b className="font-medium text-muted">{n.author}</b>
                            {n.kind === "revoke" ? <Badge tone="good">revoked</Badge> : <Badge>details</Badge>}
                            {n.notified ? <span>· sent to member</span> : <span>· internal</span>}
                            <span>· {when(n.createdAt)}</span>
                          </div>
                          <p className="mt-0.5 whitespace-pre-wrap text-muted">{n.body}</p>
                        </li>
                      ))}
                    </ol>
                  ) : null}

                  {mode?.id === w.id ? (
                    <div className="mt-3 space-y-2 rounded-xl border border-line-strong bg-panel-2 p-3">
                      <textarea
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        rows={3}
                        autoFocus
                        maxLength={mode.type === "revoke" ? 1000 : 2000}
                        placeholder={mode.type === "revoke" ? "Why is this warning being revoked?" : "Add details: context, evidence, follow-up agreed with the member…"}
                        className="w-full resize-none rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm outline-none placeholder:text-dim"
                      />
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        {mode.type === "note" ? (
                          <label className={cx("flex items-center gap-2 text-xs", w.status === "proposed" ? "text-dim" : "text-muted")}>
                            <input type="checkbox" checked={notify} disabled={w.status === "proposed"} onChange={(e) => setNotify(e.target.checked)} />
                            Also send these details to the member by DM
                          </label>
                        ) : (
                          <span className="text-[11px] text-dim">
                            {w.status === "proposed" ? "The draft is dismissed; the member never saw it." : "The member is told by DM and it stops counting as a strike."}
                          </span>
                        )}
                        <div className="flex gap-2">
                          <Button size="sm" variant="ghost" onClick={() => { setMode(null); setText(""); }}>
                            Cancel
                          </Button>
                          <Button size="sm" variant="primary" disabled={busy || text.trim().length < 3} onClick={() => submit(w)}>
                            {busy ? "Saving…" : mode.type === "revoke" ? (w.status === "proposed" ? "Dismiss draft" : "Revoke warning") : "Add details"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 flex gap-3">
                      <button type="button" onClick={() => { setMode({ id: w.id, type: "note" }); setText(""); setIssuing(false); }} className="text-xs text-muted hover:text-fg">
                        + Add details
                      </button>
                      {!withdrawn ? (
                        <button type="button" onClick={() => { setMode({ id: w.id, type: "revoke" }); setText(""); setIssuing(false); }} className="text-xs text-dim hover:text-rose-300">
                          {w.status === "proposed" ? "Dismiss draft" : "Revoke"}
                        </button>
                      ) : null}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
