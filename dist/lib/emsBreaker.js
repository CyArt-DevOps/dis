import { describeEmsError } from "./emsErrors.js";
/**
 * Cooldown for calls to EMS (2026-11-16). Every EMS call leaves from the bot's one IP, so when
 * the host starts resetting or challenging it, each retry renews the host's per-IP ban. After
 * TRIP_COUNT such failures within TRIP_WINDOW_MS the breaker opens: no EMS calls for COOLDOWN_MS.
 * Then ONE probe call is let through; success closes it, another blocked-type failure reopens it.
 *
 * Only "blocked" failures count (timeout, network, bot-check page, 429/502/503/504). Any real
 * answer from our app (2xx, 401, 400, 500...) proves the path is open and resets the count.
 */
export const TRIP_COUNT = 3;
export const TRIP_WINDOW_MS = 60_000;
export const COOLDOWN_MS = 10 * 60_000;
export class EmsCoolingDown extends Error {
    retryAt;
    constructor(retryAt) {
        super(`EMS calls paused until ${retryAt.toISOString()}`);
        this.retryAt = retryAt;
        this.name = "EmsCoolingDown";
    }
}
/** Failures that mean "the host is blocking us", not "our app answered". */
export function isBlockedFailure(err) {
    const r = describeEmsError(err);
    return (r === "timeout" ||
        r.startsWith("network_") ||
        r.endsWith("_challenge") ||
        r === "not_json_challenge" ||
        ["http_429", "http_502", "http_503", "http_504"].includes(r));
}
export class EmsBreaker {
    now;
    onEvent;
    failures = [];
    openUntil = 0;
    probing = false;
    constructor(now = Date.now, onEvent = () => { }) {
        this.now = now;
        this.onEvent = onEvent;
    }
    /** Throws EmsCoolingDown while paused. Returns true when this call is the single probe. */
    before() {
        const t = this.now();
        if (this.openUntil === 0)
            return false;
        if (t < this.openUntil || this.probing)
            throw new EmsCoolingDown(new Date(Math.max(this.openUntil, t + 30_000)));
        this.probing = true;
        return true;
    }
    success() {
        const wasOpen = this.openUntil !== 0;
        this.failures = [];
        this.openUntil = 0;
        this.probing = false;
        if (wasOpen)
            this.onEvent({ type: "closed" });
    }
    failure(err, probe) {
        if (!isBlockedFailure(err)) {
            // Our app answered (e.g. 401/500): the network path is fine.
            this.success();
            return;
        }
        const t = this.now();
        this.probing = false;
        if (probe) {
            this.open(t);
            return;
        }
        this.failures = this.failures.filter((x) => t - x < TRIP_WINDOW_MS);
        this.failures.push(t);
        if (this.failures.length >= TRIP_COUNT)
            this.open(t);
    }
    /** When calls resume, or null if not paused. */
    pausedUntil() {
        return this.openUntil && this.now() < this.openUntil ? new Date(this.openUntil) : null;
    }
    open(t) {
        this.failures = [];
        this.openUntil = t + COOLDOWN_MS;
        this.onEvent({ type: "opened", until: new Date(this.openUntil) });
    }
}
//# sourceMappingURL=emsBreaker.js.map