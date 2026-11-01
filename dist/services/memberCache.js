import { logger } from "../core/logger.js";
/**
 * /v1/members derives leadership from guild.members.cache, which is only
 * complete after a full fetch. Until one succeeds the endpoint answers 503 so
 * EMS never sees every lead as a non-lead.
 */
let ready = false;
let timer = null;
export function markMembersReady() {
    ready = true;
}
export function membersReady() {
    return ready;
}
export function resetMemberCacheForTests() {
    ready = false;
    if (timer)
        clearTimeout(timer);
    timer = null;
}
/** Retry delay after the Nth failure (0-based): 30s, 60s, 120s... capped at 10 min. */
export function warmDelayMs(failures) {
    return Math.min(30_000 * 2 ** failures, 600_000);
}
export async function warmMemberCache(guild, failures = 0) {
    try {
        await guild.members.fetch();
        markMembersReady();
    }
    catch (err) {
        const delay = warmDelayMs(failures);
        logger.warn({ err, retryInMs: delay }, "Guild member fetch failed; will retry");
        timer = setTimeout(() => void warmMemberCache(guild, failures + 1), delay);
        timer.unref();
    }
}
//# sourceMappingURL=memberCache.js.map