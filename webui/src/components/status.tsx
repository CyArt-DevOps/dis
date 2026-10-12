import { Chip } from "@heroui/react";
import type { DayStatus } from "../api";

/**
 * One place defining what each status looks like, so the calendar cells, the
 * legend and the table chips can never drift apart.
 */
export const DAY_STATUS: Record<DayStatus, { label: string; dot: string; cell: string }> = {
  good: {
    label: "Completed",
    dot: "bg-emerald-500",
    cell: "bg-emerald-500/85 text-white hover:bg-emerald-400",
  },
  partial: {
    label: "Partial",
    dot: "bg-amber-400",
    cell: "bg-amber-400/85 text-black hover:bg-amber-300",
  },
  missing: {
    label: "No log",
    dot: "bg-rose-500",
    cell: "bg-rose-500/85 text-white hover:bg-rose-400",
  },
  leave: {
    label: "Leave",
    dot: "bg-orange-500",
    cell: "bg-orange-500/85 text-white hover:bg-orange-400",
  },
  off: {
    label: "Off day",
    dot: "bg-zinc-600",
    cell: "bg-zinc-700/50 text-zinc-400",
  },
  untracked: {
    label: "Not tracked",
    dot: "bg-zinc-800 ring-1 ring-zinc-700",
    cell: "bg-transparent text-zinc-700 ring-1 ring-inset ring-zinc-800",
  },
  future: {
    label: "Upcoming",
    dot: "bg-zinc-800",
    cell: "bg-zinc-800/40 text-zinc-600",
  },
};

/** Compliance statuses from /api/compliance → chip colour. */
export const COMPLIANCE_CHIP: Record<string, { label: string; color: ChipColor }> = {
  compliant: { label: "following rules", color: "success" },
  "in-progress": { label: "in progress", color: "default" },
  "not-joined-yet": { label: "not joined yet", color: "default" },
  "late-login": { label: "late login", color: "warning" },
  "short-hours": { label: "short hours", color: "warning" },
  "late-and-short": { label: "late + short", color: "danger" },
  absent: { label: "absent", color: "danger" },
  "off-day": { label: "off day", color: "default" },
  untracked: { label: "not tracked", color: "default" },
};

type ChipColor = "default" | "success" | "warning" | "danger";

export function StatusChip({ status }: { status: string }) {
  const s = COMPLIANCE_CHIP[status] ?? { label: status, color: "default" as ChipColor };
  return (
    <Chip color={s.color} size="sm" variant="soft">
      {s.label}
    </Chip>
  );
}

export function Legend() {
  const shown: DayStatus[] = ["good", "partial", "missing", "leave", "off", "untracked"];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {shown.map((s) => (
        <span key={s} className="flex items-center gap-1.5">
          <span className={`inline-block size-2.5 rounded-full ${DAY_STATUS[s].dot}`} />
          {DAY_STATUS[s].label}
        </span>
      ))}
    </div>
  );
}
