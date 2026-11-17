import { logger } from "./logger.js";
/** Resolves when `p` settles or after `ms`, whichever is first. Never rejects. */
async function bounded(p, ms, step) {
    let timer;
    const timedOut = new Promise((r) => {
        timer = setTimeout(() => r("timeout"), ms);
    });
    try {
        const res = await Promise.race([p.then(() => "ok"), timedOut]);
        if (res === "timeout")
            logger.warn({ step, ms }, "Shutdown step timed out, continuing");
    }
    catch (err) {
        logger.error({ err, step }, "Shutdown step failed, continuing");
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Graceful shutdown that always ends in exit. Every step is bounded: in prod
 * the Prisma disconnect sometimes never returned (stale pool after DB blips),
 * so process.exit was never reached and systemd waited its full 120 s stop
 * timeout before SIGKILL, on every such restart.
 */
export async function runShutdown(d) {
    const watchdog = setTimeout(() => {
        logger.warn({ ms: d.hardDeadlineMs }, "Shutdown deadline reached, forcing exit");
        d.exit(0);
    }, d.hardDeadlineMs);
    try {
        d.stopTimers();
    }
    catch (err) {
        logger.error({ err }, "Stopping timers failed, continuing");
    }
    await bounded(Promise.resolve().then(d.closeSessions), d.sessionsTimeoutMs, "close voice sessions");
    await bounded(Promise.resolve().then(d.disconnect), d.disconnectTimeoutMs, "db disconnect");
    await bounded(Promise.resolve().then(d.destroyClient), 3_000, "discord client destroy");
    clearTimeout(watchdog);
    logger.info("Shutdown complete");
    d.exit(0);
}
//# sourceMappingURL=shutdown.js.map