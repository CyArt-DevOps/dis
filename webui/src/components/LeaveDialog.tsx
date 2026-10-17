import { useEffect, useMemo, useState } from "react";
import { dayLabel, monthLabel, post, shiftMonth } from "../api";
import { Badge, Button, Select, cx } from "./ui";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const APPROVER_KEY = "dash.approvedBy";

function daysOf(month: string): string[] {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

function isoWeekday(day: string): number {
  return new Date(day + "T00:00:00Z").getUTCDay() || 7;
}

function readApprover(): string {
  try {
    return localStorage.getItem(APPROVER_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * HR grants approved leave for hand-picked days. Days already covered by an
 * approved leave are marked so HR doesn't double-grant; non-working days can
 * still be picked but are dimmed, since they don't affect attendance.
 */
export function LeaveDialog({
  userId,
  name,
  startMonth,
  today,
  workdays,
  coveredDays,
  onClose,
  onGranted,
}: {
  userId: string;
  name: string;
  startMonth: string;
  today: string;
  workdays: number[];
  coveredDays: Set<string>;
  onClose: () => void;
  onGranted: (message: string) => void;
}) {
  const [month, setMonth] = useState(startMonth);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [type, setType] = useState("casual");
  const [reason, setReason] = useState("");
  const [approvedBy, setApprovedBy] = useState(readApprover);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const days = useMemo(() => daysOf(month), [month]);
  const lead = isoWeekday(days[0]!) - 1;
  const sorted = [...picked].sort();
  const workingPicked = sorted.filter((d) => workdays.includes(isoWeekday(d))).length;

  const toggle = (d: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });

  const submit = async () => {
    setError(null);
    if (!sorted.length) return setError("Pick at least one date.");
    if (reason.trim().length < 3) return setError("Add a reason (at least 3 characters).");
    if (approvedBy.trim().length < 2) return setError("Enter your name as the approving HR member.");
    setBusy(true);
    try {
      try {
        localStorage.setItem(APPROVER_KEY, approvedBy.trim());
      } catch {
        /* storage unavailable — the name just isn't remembered */
      }
      const out = await post<{ id: number; days: string[]; excusedMeetings: number }>(
        `/api/profile/${encodeURIComponent(userId)}/leave`,
        { dates: sorted, type, reason: reason.trim(), approvedBy: approvedBy.trim() }
      );
      onGranted(
        `Leave #${out.id} approved for ${out.days.length} day${out.days.length === 1 ? "" : "s"}` +
          (out.excusedMeetings ? ` · ${out.excusedMeetings} meeting absence${out.excusedMeetings === 1 ? "" : "s"} excused` : "")
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm" onClick={() => !busy && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Grant leave to ${name}`}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-2xl border border-line-strong bg-panel shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-6 py-4">
          <div>
            <h2 className="text-gradient text-lg font-semibold">Grant leave</h2>
            <p className="text-xs text-dim">
              Approved immediately for <b className="font-medium text-muted">{name}</b>. Picked days count as leave, not absence, and
              meeting absences on them become excused.
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy} aria-label="Close">
            ✕
          </Button>
        </div>

        <div className="grid gap-6 p-6 md:grid-cols-[1.1fr_1fr]">
          {/* Date picker */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <Button size="sm" variant="ghost" onClick={() => setMonth(shiftMonth(month, -1))}>
                ←
              </Button>
              <span className="text-sm font-medium">{monthLabel(month)}</span>
              <Button size="sm" variant="ghost" onClick={() => setMonth(shiftMonth(month, 1))}>
                →
              </Button>
            </div>
            <div className="grid grid-cols-7 gap-1 text-center">
              {WEEKDAYS.map((w) => (
                <div key={w} className="pb-1 text-[11px] text-dim">
                  {w}
                </div>
              ))}
              {Array.from({ length: lead }, (_, i) => (
                <div key={`pad-${i}`} />
              ))}
              {days.map((d) => {
                const on = picked.has(d);
                const working = workdays.includes(isoWeekday(d));
                const covered = coveredDays.has(d);
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => toggle(d)}
                    title={covered ? `${d} — already on approved leave` : working ? d : `${d} — non-working day`}
                    className={cx(
                      "relative aspect-square rounded-lg text-sm tabular-nums transition-colors",
                      on
                        ? "bg-white font-semibold text-black"
                        : covered
                          ? "bg-orange-400/20 text-orange-200 ring-1 ring-inset ring-orange-400/40"
                          : working
                            ? "bg-white/[0.04] text-fg hover:bg-white/[0.1]"
                            : "text-dim hover:bg-white/[0.05]",
                      d === today && !on && "ring-1 ring-inset ring-white/40"
                    )}
                  >
                    {Number(d.slice(-2))}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-dim">
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-sm bg-white" /> selected
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-sm bg-orange-400/50" /> already on leave
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-sm ring-1 ring-white/40" /> today
              </span>
            </div>
          </div>

          {/* Details */}
          <div className="flex flex-col gap-3">
            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs text-muted">
                <span>Selected days</span>
                {sorted.length ? (
                  <button type="button" className="text-dim hover:text-fg" onClick={() => setPicked(new Set())}>
                    clear
                  </button>
                ) : null}
              </div>
              <div className="scroll-thin flex max-h-24 min-h-9 flex-wrap gap-1.5 overflow-y-auto rounded-xl border border-line bg-panel-2 p-2">
                {sorted.length ? (
                  sorted.map((d) => (
                    <button key={d} type="button" onClick={() => toggle(d)} title="Remove">
                      <Badge tone={workdays.includes(isoWeekday(d)) ? "leave" : "neutral"}>
                        {dayLabel(d, { day: "numeric", month: "short", weekday: "short" })} ✕
                      </Badge>
                    </button>
                  ))
                ) : (
                  <span className="px-1 text-xs text-dim">Click dates on the calendar</span>
                )}
              </div>
              {sorted.length ? (
                <p className="mt-1 text-[11px] text-dim">
                  {workingPicked} working day{workingPicked === 1 ? "" : "s"}
                  {sorted.length - workingPicked ? ` · ${sorted.length - workingPicked} non-working` : ""}
                </p>
              ) : null}
            </div>

            <label className="text-xs text-muted">
              Leave type
              <Select
                label="Leave type"
                className="mt-1.5"
                value={type}
                onChange={setType}
                options={[
                  { value: "casual", label: "Casual" },
                  { value: "sick", label: "Sick" },
                  { value: "exam", label: "Exam" },
                ]}
              />
            </label>

            <label className="text-xs text-muted">
              Reason
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                rows={3}
                placeholder="e.g. Medical certificate submitted to HR"
                className="mt-1.5 w-full resize-none rounded-xl border border-line-strong bg-panel px-3 py-2 text-sm text-fg outline-none placeholder:text-dim focus-visible:ring-2 focus-visible:ring-white/30"
              />
            </label>

            <label className="text-xs text-muted">
              Approved by (HR)
              <input
                value={approvedBy}
                onChange={(e) => setApprovedBy(e.target.value)}
                maxLength={60}
                placeholder="Your name"
                className="mt-1.5 h-9 w-full rounded-full border border-line-strong bg-panel px-3.5 text-sm text-fg outline-none placeholder:text-dim focus-visible:ring-2 focus-visible:ring-white/30"
              />
            </label>

            {error ? <p className="rounded-lg border border-rose-400/25 bg-rose-400/5 px-3 py-2 text-xs text-rose-300">{error}</p> : null}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-6 py-4">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || !sorted.length}>
            {busy ? "Approving…" : `Approve leave${sorted.length ? ` · ${sorted.length} day${sorted.length === 1 ? "" : "s"}` : ""}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
