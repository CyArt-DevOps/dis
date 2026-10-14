/**
 * Restore a backup produced by `npm run db:backup`.
 *
 *   npm run db:restore -- backups/backup-2026-10-14T11-30-00.json.gz
 *
 * Writes into whatever DATABASE_URL points at, so point it at the target you
 * mean. The schema must already exist there (`prisma migrate deploy`).
 *
 * A backup nobody has restored is a guess, not a backup — `npm run db:verify`
 * exercises this script end to end against a scratch database.
 *
 * Safety: refuses to touch a database that already holds rows unless --force is
 * passed, in which case it clears children-first before loading.
 */
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { prisma } from "../src/core/db.js";

const BATCH = 500;
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

const model = (t: Table) =>
  (prisma as unknown as Record<Table, {
    count: () => Promise<number>;
    createMany: (a: { data: unknown[] }) => Promise<{ count: number }>;
    deleteMany: () => Promise<{ count: number }>;
  }>)[t];

/** Full ISO timestamps only — Attendance.day ("2026-10-14") must stay a string. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function revive(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === "string" && ISO.test(v) ? new Date(v) : v;
  }
  return out;
}

async function read(file: string): Promise<{ counts: Record<string, number>; data: Record<string, Record<string, unknown>[]> }> {
  const chunks: Buffer[] = [];
  await new Promise<void>((ok, bad) => {
    createReadStream(file)
      .pipe(createGunzip())
      .on("data", (c: Buffer) => chunks.push(c))
      .on("end", () => ok())
      .on("error", bad);
  });
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main(): Promise<void> {
  const file = process.argv.find((a) => a.endsWith(".json.gz"));
  if (!file) {
    console.error("Usage: npm run db:restore -- <backup file.json.gz> [--force]");
    process.exit(1);
  }
  const force = process.argv.includes("--force");
  const backup = await read(file);
  console.log(`restoring ${file}`);

  let existing = 0;
  for (const t of TABLES) existing += await model(t).count();
  if (existing > 0) {
    if (!force) {
      console.error(`Target already holds ${existing} rows. Pass --force to clear it first.`);
      process.exit(1);
    }
    for (const t of [...TABLES].reverse()) await model(t).deleteMany();
    console.log("target cleared");
  }

  let bad = 0;
  for (const t of TABLES) {
    const rows = (backup.data[t] ?? []).map(revive);
    for (let i = 0; i < rows.length; i += BATCH) {
      await model(t).createMany({ data: rows.slice(i, i + BATCH) });
    }
    const after = await model(t).count();
    const want = backup.counts[t] ?? rows.length;
    if (after !== want) {
      console.error(`MISMATCH ${t}: backup ${want} vs restored ${after}`);
      bad++;
    }
    console.log(`  ${t.padEnd(18)} ${after}`);
  }
  console.log(bad === 0 ? "\nRestore verified." : `\n${bad} table(s) mismatched.`);
  process.exit(bad === 0 ? 0 : 1);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
