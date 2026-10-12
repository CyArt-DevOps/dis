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
 * SQLite defaults are wrong for a bot that writes continuously while the
 * dashboard reads:
 *
 * - `journal_mode=WAL` lets readers run concurrently with the writer. In the
 *   default rollback-journal mode a write takes an EXCLUSIVE lock on the whole
 *   file, so an attendance flush and a calendar query fight, and Prisma reports
 *   the loser as P1008 "Operations timed out". WAL is stored in the database
 *   file, so this sticks once applied.
 * - `busy_timeout` makes a blocked statement WAIT instead of failing instantly.
 *   Without it SQLite's default is 0 — any contention is an immediate error.
 * - `synchronous=NORMAL` is the standard, safe-under-WAL setting: durable
 *   against process crashes, only at risk from OS/power loss.
 */
async function applyPragmas() {
    // These PRAGMAs return a row, so they must go through $queryRaw —
    // $executeRaw fails with "Execute returned results, which is not allowed".
    const [mode] = await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL");
    await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 10000");
    await prisma.$executeRawUnsafe("PRAGMA synchronous = NORMAL");
    const journalMode = mode?.journal_mode ?? "unknown";
    if (journalMode.toLowerCase() !== "wal") {
        logger.warn({ journalMode }, "SQLite is NOT in WAL mode — expect lock contention");
    }
    else {
        logger.info({ journalMode, busyTimeoutMs: 10000 }, "SQLite tuned for concurrent access");
    }
}
export async function connectDb() {
    await prisma.$connect();
    await applyPragmas();
    logger.info("Database connected");
}
export async function disconnectDb() {
    await prisma.$disconnect();
}
/** Prisma codes worth retrying: pool/query timeout and an open transaction conflict. */
const TRANSIENT_CODES = new Set(["P1008", "P2034"]);
function isTransient(err) {
    const e = err;
    if (e?.code && TRANSIENT_CODES.has(e.code))
        return true;
    return Boolean(e?.message && /database is locked|SQLITE_BUSY/i.test(e.message));
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