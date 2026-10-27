/**
 * Pure attendance math for meetings (Phase 3 §3.2). No Discord, no DB.
 *
 * secondsAttended = time a member spent in the meeting's voice channel, clipped
 * to [startAt, startAt + durationMin]. Overlapping sessions (a reconnect the bot
 * recorded twice, a restart reconcile) are merged so time is never counted twice.
 */
export const LEFT_EARLY_RATIO = 0.7;

export type MeetingStatus = "present" | "late" | "left_early" | "absent" | "excused";

export interface SessionSpan {
  joinedAt: Date;
  leftAt: Date | null;
}

export function secondsInWindow(sessions: SessionSpan[], start: Date, end: Date, now: Date): number {
  const from = start.getTime();
  const to = Math.min(end.getTime(), now.getTime());
  const spans = sessions
    .map((s) => [Math.max(s.joinedAt.getTime(), from), Math.min((s.leftAt ?? now).getTime(), to)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let ms = 0;
  let curA = -1;
  let curB = -1;
  for (const [a, b] of spans) {
    if (a > curB) {
      if (curB > curA) ms += curB - curA;
      curA = a;
      curB = b;
    } else if (b > curB) {
      curB = b;
    }
  }
  if (curB > curA) ms += curB - curA;
  return Math.floor(ms / 1000);
}

/** The meeting's own window, without the attendance grace period. */
export function meetingWindow(m: { startAt: Date; durationMin: number }): { start: Date; end: Date } {
  return { start: m.startAt, end: new Date(m.startAt.getTime() + m.durationMin * 60_000) };
}

/**
 * Status after the end-of-meeting pass. Only joined members (present / late)
 * can become left_early; excused and absent are left as they are. Approved
 * leave is applied afterwards and wins over both absent and left_early.
 */
export function statusAfterTimes(status: string, secondsAttended: number, durationMin: number): string {
  if (status !== "present" && status !== "late") return status;
  return secondsAttended < LEFT_EARLY_RATIO * durationMin * 60 ? "left_early" : status;
}

/** Joined status to restore when a dashboard leave grant is revoked. */
export function joinedStatus(minutesLate: number, secondsAttended: number, durationMin: number): string {
  return statusAfterTimes(minutesLate > 0 ? "late" : "present", secondsAttended, durationMin);
}
