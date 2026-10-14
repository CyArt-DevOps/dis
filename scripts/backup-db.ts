/**
 * Full backup of the database to a local gzipped JSON file.
 *
 *   npm run db:backup
 *
 * Why this exists: the data lives only in TiDB Cloud now. The free tier has no
 * backup guarantee you can rely on, and the host's old SQLite file went stale
 * the moment the bot started writing to TiDB. One deleted cluster, one expired
 * free plan, or one bad query and 900 members, 45,000 voice sessions and every
 * leave record are gone. A backup you hold yourself removes that.
 *
 * The file is a plain object of table -> rows, so it can be read without this
 * codebase. Dates are ISO strings; `scripts/restore-db.ts` converts them back.
 *
 * Old backups are pruned, keeping the most recent KEEP files.
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { prisma } from "../src/core/db.js";
import { logger } from "../src/core/logger.js";

const KEEP = 14;
const DIR = resolve(process.cwd(), "backups");

/** Every table, in an order a restore can replay parents-first. */
export const TABLES = [
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
  (prisma as unknown as Record<Table, { findMany: () => Promise<unknown[]> }>)[t];

function prune(): void {
  const files = readdirSync(DIR)
    .filter((f) => f.startsWith("backup-") && f.endsWith(".json.gz"))
    .map((f) => ({ f, t: statSync(resolve(DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(KEEP)) {
    unlinkSync(resolve(DIR, f));
    logger.info({ file: f }, "Pruned old backup");
  }
}

async function main(): Promise<void> {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

  const data: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    const rows = await model(t).findMany();
    data[t] = rows;
    counts[t] = rows.length;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = resolve(DIR, `backup-${stamp}.json.gz`);
  const payload = JSON.stringify({ takenAt: new Date().toISOString(), counts, data });

  await pipeline(Readable.from([payload]), createGzip({ level: 9 }), createWriteStream(file));

  const mb = (statSync(file).size / 1024 / 1024).toFixed(2);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  logger.info({ file, mb: Number(mb), rows: total, counts }, "Backup complete");
  console.log(`Backup written: ${file} (${mb} MB, ${total} rows)`);
  prune();
}

main()
  .catch((err) => {
    logger.error({ err }, "Backup FAILED");
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
