/**
 * One-time copy of the SQLite database into TiDB (MySQL).
 *
 *   SQLITE_URL=file:./data/snapshot/app.db npm run db:tidb:copy
 *
 * Reads through a client generated from `prisma/sqlite-source.prisma` (the old
 * schema, kept read-only) and writes through the live MySQL client, so both
 * shapes are available in one process.
 *
 * Properties that matter:
 *  - Primary keys are carried over verbatim. Meeting ids are referenced by
 *    MeetingAttendance, and LeaveRequest ids appear in live Discord channel
 *    names (`leave-<id>`), so renumbering would break both.
 *  - Tables are copied parents-first, and the script refuses to run against a
 *    non-empty target unless --force is passed, so a partial run cannot silently
 *    double-insert.
 *  - Row counts are compared at the end and a mismatch exits non-zero.
 */
import { PrismaClient as SqliteClient } from "../generated/sqlite-client/index.js";
import { PrismaClient as MysqlClient } from "@prisma/client";

const BATCH = 500;
const force = process.argv.includes("--force");
const sqliteUrl = process.env.SQLITE_URL ?? "file:./data/snapshot/app.db";

const src = new SqliteClient({ datasources: { db: { url: sqliteUrl } } });
const dst = new MysqlClient();

/** Tables in dependency order: anything referenced comes before its referents. */
const TABLES = [
  "member",
  "ticket",
  "voiceSession",
  "attendance",
  "warn",
  "voiceGrant",
  "meeting",
  "meetingAttendance",
  "leaveRequest",
  "scheduledMessage",
] as const;

type Table = (typeof TABLES)[number];

const model = (c: SqliteClient | MysqlClient, t: Table) =>
  (c as unknown as Record<Table, {
    count: () => Promise<number>;
    findMany: (a?: unknown) => Promise<unknown[]>;
    createMany: (a: { data: unknown[] }) => Promise<{ count: number }>;
    deleteMany: () => Promise<{ count: number }>;
  }>)[t];

async function main(): Promise<void> {
  console.log(`source: ${sqliteUrl}`);

  const existing: Partial<Record<Table, number>> = {};
  for (const t of TABLES) existing[t] = await model(dst, t).count();
  const total = Object.values(existing).reduce((a, b) => a + (b ?? 0), 0);
  if (total > 0) {
    if (!force) {
      console.error(
        `Target already holds ${total} rows: ${JSON.stringify(existing)}\n` +
          "Re-run with --force to clear it first, or point at an empty database."
      );
      process.exit(1);
    }
    // Children first on the way out.
    for (const t of [...TABLES].reverse()) await model(dst, t).deleteMany();
    console.log("target cleared");
  }

  const copied: Record<string, number> = {};
  for (const t of TABLES) {
    const rows = (await model(src, t).findMany()) as Record<string, unknown>[];
    for (let i = 0; i < rows.length; i += BATCH) {
      await model(dst, t).createMany({ data: rows.slice(i, i + BATCH) });
    }
    copied[t] = rows.length;
    console.log(`  ${t.padEnd(18)} ${rows.length}`);
  }

  let bad = 0;
  for (const t of TABLES) {
    const after = await model(dst, t).count();
    if (after !== copied[t]) {
      console.error(`MISMATCH ${t}: source ${copied[t]} vs target ${after}`);
      bad++;
    }
  }
  console.log(bad === 0 ? "\nAll tables verified." : `\n${bad} table(s) mismatched.`);
  process.exit(bad === 0 ? 0 : 1);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await src.$disconnect().catch(() => {});
    await dst.$disconnect().catch(() => {});
  });
