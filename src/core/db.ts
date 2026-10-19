import { PrismaClient } from "@prisma/client";
import { logger } from "./logger.js";

const base = new PrismaClient({
  log: [
    { level: "warn", emit: "event" },
    { level: "error", emit: "event" },
  ],
});

base.$on("warn", (e) => logger.warn({ prisma: e.message }, "Prisma warn"));
base.$on("error", (e) => logger.error({ prisma: e.message }, "Prisma error"));

/**
 * Writes that are NOT safe to repeat blindly. A dropped connection usually means
 * the statement never committed, but "usually" is not good enough for an insert:
 * a retry after a commit we never saw acknowledged would create a second ticket
 * or a second leave request. Those fail loudly instead, and the user retries.
 * Everything else here is a read, an update, an upsert or a delete — all
 * idempotent, so repeating them is safe.
 */
const NON_IDEMPOTENT = new Set(["create", "createMany", "createManyAndReturn"]);

/**
 * Tables whose ids people read: ticket titles, `ticket-<id>` / `leave-<id>`
 * channel names, meeting numbers.
 *
 * TiDB's auto-increment cannot be trusted to stay sequential. With the default
 * cache it jumps by 30000 after every restart; even with AUTO_ID_CACHE 1 the
 * serverless tier restarts the allocator when it scales to zero and skips ahead
 * by its 4000-id batch (ticket 524 -> 4002, leave 4002 -> 8002). So these ids
 * are assigned here as MAX(id) + 1 instead of by the database.
 */
const SEQUENTIAL = new Set(["Ticket", "LeaveRequest", "Meeting"]);

async function createSequential(
  model: string,
  args: { data: Record<string, unknown> },
  query: (a: unknown) => Promise<unknown>
): Promise<unknown> {
  if (args.data.id !== undefined) return query(args);
  for (let attempt = 0; ; attempt++) {
    const [row] = await withDbRetry(() =>
      base.$queryRawUnsafe<{ next: bigint | number }[]>(
        `SELECT COALESCE(MAX(id), 0) + 1 AS next FROM \`${model}\``
      )
    );
    const id = Number(row!.next);
    try {
      return await query({ ...args, data: { ...args.data, id } });
    } catch (err) {
      // Two creates raced for the same id: the loser inserted nothing, so
      // taking the next free id is safe (unlike retrying a dropped connection).
      const e = err as { code?: string; meta?: { target?: unknown } };
      const pkClash = e?.code === "P2002" && /PRIMARY|\bid\b/i.test(String(e.meta?.target ?? ""));
      if (!pkClash || attempt >= 4) throw err;
    }
  }
}

/**
 * Retry transient database failures for every query, not just the handful of
 * call sites that remembered to ask for it.
 *
 * TiDB's serverless gateway closes pooled connections it considers idle, which
 * surfaces mid-operation as "Server has closed the connection." On SQLite there
 * was no connection to lose, so most call sites never considered the case —
 * which is why a dropped connection took out meeting attendance tracking
 * (`onMeetingStart failed`) rather than being retried and forgotten.
 */
export const prisma = base.$extends({
  query: {
    async $allOperations({ model, operation, args, query }) {
      if (operation === "create" && model && SEQUENTIAL.has(model)) {
        return createSequential(model, args as { data: Record<string, unknown> }, query as never);
      }
      if (NON_IDEMPOTENT.has(operation)) return query(args);
      return withDbRetry(() => query(args));
    },
  },
});

/**
 * TiDB needs no session tuning here.
 *
 * This used to apply SQLite PRAGMAs (WAL, busy_timeout, synchronous) because a
 * single file served both the bot's continuous writes and the dashboard's
 * reads, and the default locking made them fight. TiDB is a networked, MVCC
 * database: readers never block writers, so the contention those settings
 * existed to solve does not arise. PRAGMA is also not valid MySQL syntax.
 */

/**
 * Connect, retrying transient failures.
 *
 * On SQLite the database was a local file: if the process started, it was
 * there. TiDB is across a network and scales to zero when idle, so the first
 * connection can time out while the cluster resumes, and a brief blip on the
 * way out is normal. Without this retry a single P1001 killed the process at
 * boot and it stayed dead until someone noticed — which is exactly how the
 * server went offline, leaving 22 voice sessions to be closed by crash
 * recovery on the next start.
 *
 * Only reachability failures are retried. A wrong URL or bad credentials still
 * fails fast, because retrying those just delays an error a human must fix.
 *
 * `attempts = 0` means keep trying. Nothing restarts this process if it exits,
 * so for a database that is merely unreachable the right behaviour is to wait
 * for it to come back rather than die and need a human to press Start.
 */
const UNREACHABLE = new Set(["P1001", "P1002", "P1017"]);
const MAX_RETRY_DELAY_MS = 60_000;

export async function connectDb(attempts = 0): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await base.$connect();
      // One cheap round trip, so a bad DATABASE_URL or a blocked egress port
      // fails here with a clear message instead of on the first real query.
      const started = Date.now();
      await base.$queryRawUnsafe("SELECT 1");
      logger.info({ rttMs: Date.now() - started, attempt: i }, "Database connected");
      return;
    } catch (err) {
      const code = (err as { errorCode?: string; code?: string })?.code
        ?? (err as { errorCode?: string })?.errorCode;
      const exhausted = attempts > 0 && i >= attempts;
      if (!code || !UNREACHABLE.has(code) || exhausted) throw err;
      // 2s, 4s, 8s, 16s, ... capped at a minute.
      const delay = Math.min(2000 * 2 ** (i - 1), MAX_RETRY_DELAY_MS);
      logger.warn(
        { err: (err as Error).message, code, attempt: i, nextRetryMs: delay },
        "Database unreachable — retrying"
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export async function disconnectDb(): Promise<void> {
  await base.$disconnect();
}

/** Prisma codes worth retrying: pool/query timeout and an open transaction conflict. */
const TRANSIENT_CODES = new Set([
  "P1008", // operations timed out
  "P2034", // transaction write conflict
  "P1017", // server has closed the connection
  "P2024", // timed out fetching a connection from the pool
]);

/**
 * Transient now means something different than it did on SQLite: instead of a
 * locked file, it is a deadlock, a lock-wait timeout, or a connection the
 * serverless gateway closed while idle. All three are safe to retry.
 */
function isTransient(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  if (e?.code && TRANSIENT_CODES.has(e.code)) return true;
  // Match on text too: the serverless gateway's dropped-connection error
  // surfaces as "Server has closed the connection." and does not always carry
  // a code we can rely on.
  return Boolean(
    e?.message &&
      /deadlock|lock wait timeout|server has gone away|closed the connection|connection (?:is )?closed|connection reset|ECONNRESET|EPIPE|ETIMEDOUT|write epoll/i.test(
        e.message
      )
  );
}

/**
 * Retry a database operation through transient lock contention.
 *
 * Attendance writes are driven by gateway events that never come again — a
 * dropped voice-join write is a hole in someone's attendance. The reconcile
 * sweep would repair it within a minute, but retrying here keeps the record
 * exact and the logs quiet.
 */
export async function withDbRetry<T>(op: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await op();
    } catch (err) {
      if (!isTransient(err)) throw err;
      lastErr = err;
      // 100ms, 300ms, 900ms — long enough for a slow read to finish.
      await new Promise((r) => setTimeout(r, 100 * 3 ** i));
    }
  }
  throw lastErr;
}
