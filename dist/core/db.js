import { PrismaClient } from "@prisma/client";
import { logger } from "./logger.js";
export const prisma = new PrismaClient({
    log: [
        { level: "warn", emit: "event" },
        { level: "error", emit: "event" },
    ],
});
prisma.$on("warn", (e) => logger.warn({ prisma: e.message }, "Prisma warn"));
prisma.$on("error", (e) => logger.error({ prisma: e.message }, "Prisma error"));
/**
 * TiDB needs no session tuning here.
 *
 * This used to apply SQLite PRAGMAs (WAL, busy_timeout, synchronous) because a
 * single file served both the bot's continuous writes and the dashboard's
 * reads, and the default locking made them fight. TiDB is a networked, MVCC
 * database: readers never block writers, so the contention those settings
 * existed to solve does not arise. PRAGMA is also not valid MySQL syntax.
 */
export async function connectDb() {
    await prisma.$connect();
    // One cheap round trip, so a bad DATABASE_URL or a blocked egress port fails
    // here with a clear message instead of on the first real query minutes later.
    const started = Date.now();
    await prisma.$queryRawUnsafe("SELECT 1");
    logger.info({ rttMs: Date.now() - started }, "Database connected");
}
export async function disconnectDb() {
    await prisma.$disconnect();
}
/** Prisma codes worth retrying: pool/query timeout and an open transaction conflict. */
const TRANSIENT_CODES = new Set(["P1008", "P2034", "P1017"]);
/**
 * Transient now means something different than it did on SQLite: instead of a
 * locked file, it is a deadlock, a lock-wait timeout, or a connection the
 * serverless gateway closed while idle. All three are safe to retry.
 */
function isTransient(err) {
    const e = err;
    if (e?.code && TRANSIENT_CODES.has(e.code))
        return true;
    return Boolean(e?.message &&
        /deadlock|lock wait timeout|server has gone away|connection (?:is )?closed|ECONNRESET|write epoll/i.test(e.message));
}
/**
 * Retry a database operation through transient lock contention.
 *
 * Attendance writes are driven by gateway events that never come again — a
 * dropped voice-join write is a hole in someone's attendance. The reconcile
 * sweep would repair it within a minute, but retrying here keeps the record
 * exact and the logs quiet.
 */
export async function withDbRetry(op, attempts = 3) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            return await op();
        }
        catch (err) {
            if (!isTransient(err))
                throw err;
            lastErr = err;
            // 100ms, 300ms, 900ms — long enough for a slow read to finish.
            await new Promise((r) => setTimeout(r, 100 * 3 ** i));
        }
    }
    throw lastErr;
}
//# sourceMappingURL=db.js.map