import type { DayStatus, ViolationKind } from "../api";
import { Badge, type Tone } from "./ui";

/**
 * One place defining what each status looks like, so the calendar cells, the
 * legend and the table badges can never drift apart.
 */
export const DAY_STATUS: Record<DayStatus, { label: string; dot: string; cell: string }> = {
  good: {
    label: "Completed",
    dot: "bg-emerald-400",
    cell: "bg-emerald-400/90 text-emerald-950 hover:bg-emerald-300",
  },
  partial: {
    label: "Partial",
    dot: "bg-amber-400",
    cell: "bg-amber-400/90 text-amber-950 hover:bg-amber-300",
  },
  missing: {
    label: "Absent",
    dot: "bg-rose-400",
    cell: "bg-rose-400/85 text-rose-950 hover:bg-rose-300",
  },
  leave: {
    label: "Leave",
    dot: "bg-orange-400",
    cell: "bg-orange-400/85 text-orange-950 hover:bg-orange-300",
  },
  off: {
    label: "Off day",
    dot: "bg-zinc-600",
    cell: "bg-white/[0.04] text-zinc-500",
  },
  untracked: {
    label: "Not tracked",
    dot: "bg-transparent ring-1 ring-zinc-700",
    cell: "bg-transparent text-zinc-700 ring-1 ring-inset ring-white/5",
  },
  future: {
    label: "Upcoming",
    dot: "bg-zinc-800",
    cell: "bg-white/[0.02] text-zinc-600",
  },
};

/** Compliance statuses from /api/compliance → badge. */
export const COMPLIANCE: Record<string, { label: string; tone: Tone }> = {
  compliant: { label: "Following rules", tone: "good" },
  "in-progress": { label: "In progress", tone: "info" },
  "not-joined-yet": { label: "Not joined yet", tone: "neutral" },
  "late-login": { label: "Late login", tone: "warn" },
  "short-hours": { label: "Short hours", tone: "warn" },
  "late-and-short": { label: "Late + short", tone: "bad" },
  absent: { label: "Absent", tone: "bad" },
  "off-day": { label: "Off day", tone: "neutral" },
  untracked: { label: "Not tracked", tone: "neutral" },
};

export const VIOLATION_STATUSES = ["late-login", "short-hours", "late-and-short", "absent"];

export function StatusChip({ status }: { status: string }) {
  const s = COMPLIANCE[status] ?? { label: status, tone: "neutral" as Tone };
  return (
    <Badge tone={s.tone} dot>
      {s.label}
    </Badge>
  );
}

export const VIOLATION_META: Record<ViolationKind, { label: string; tone: Tone }> = {
  absent: { label: "Absent", tone: "bad" },
  "late-login": { label: "Late login", tone: "warn" },
  "short-hours": { label: "Short hours", tone: "warn" },
  "meeting-absent": { label: "Missed meeting", tone: "bad" },
  "meeting-late": { label: "Late to meeting", tone: "warn" },
  warning: { label: "Warning", tone: "bad" },
};

export function Legend() {
  const shown: DayStatus[] = ["good", "partial", "missing", "leave", "off", "untracked"];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-dim">
      {shown.map((s) => (
        <span key={s} className="flex items-center gap-1.5">
          <span className={`inline-block size-2.5 rounded-[3px] ${DAY_STATUS[s].dot}`} />
          {DAY_STATUS[s].label}
        </span>
      ))}
    </div>
  );
}
