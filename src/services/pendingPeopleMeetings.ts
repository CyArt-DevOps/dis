import type { ScheduleArgs } from "./meetingScheduler.js";

/** ScheduleArgs minus the member list, held while the organizer picks people. */
export type PendingPeopleMeeting = Omit<ScheduleArgs, "audienceMemberIds">;

const PENDING_TTL_MS = 10 * 60_000;

const pending = new Map<string, { args: PendingPeopleMeeting; expiresAt: number }>();

/** Stash a schedule-in-progress while the organizer picks people via the select menu. */
export function setPendingPeopleMeeting(userId: string, args: PendingPeopleMeeting): void {
  pending.set(userId, { args, expiresAt: Date.now() + PENDING_TTL_MS });
}

/** Retrieve and validate a pending schedule; returns undefined if missing or expired. */
export function getPendingPeopleMeeting(userId: string): PendingPeopleMeeting | undefined {
  const entry = pending.get(userId);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    pending.delete(userId);
    return undefined;
  }
  return entry.args;
}

export function deletePendingPeopleMeeting(userId: string): void {
  pending.delete(userId);
}
