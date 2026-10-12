const PENDING_TTL_MS = 10 * 60_000;
const pending = new Map();
/** Stash a schedule-in-progress while the organizer picks people via the select menu. */
export function setPendingPeopleMeeting(userId, args) {
    pending.set(userId, { args, expiresAt: Date.now() + PENDING_TTL_MS });
}
/** Retrieve and validate a pending schedule; returns undefined if missing or expired. */
export function getPendingPeopleMeeting(userId) {
    const entry = pending.get(userId);
    if (!entry)
        return undefined;
    if (entry.expiresAt <= Date.now()) {
        pending.delete(userId);
        return undefined;
    }
    return entry.args;
}
export function deletePendingPeopleMeeting(userId) {
    pending.delete(userId);
}
//# sourceMappingURL=pendingPeopleMeetings.js.map