/**
 * Prove the newest backup can actually be restored.
 *
 *   npm run db:verify
 *
 * A backup nobody has restored is a guess. This takes the most recent file,
 * builds a scratch database next to the real one, applies the schema, restores
 * into it, compares every table against the backup's own counts, then drops the
 * scratch database. Production is never touched: the only thing pointed at the
 * live database is the read that the backup already did.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

// Windows refuses to spawn a .cmd shim without a shell, and the project path
// contains a space, so commands go through the shell fully quoted.
const run = promisify(exec);
const q = (s: string) => `"${s}"`;
const SCRATCH_DB = "cyart_backup_verify";

function newestBackup(): string {
  const dir = resolve(process.cwd(), "backups");
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("backup-") && f.endsWith(".json.gz"))
    .map((f) => ({ f: resolve(dir, f), t: statSync(resolve(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (files.length === 0) throw new Error("No backups found — run `npm run db:backup` first.");
  return files[0]!.f;
}

/** Same server and credentials, different database name. */
function scratchUrl(live: string): string {
  const u = new URL(live);
  u.pathname = `/${SCRATCH_DB}`;
  return u.toString();
}

async function counts(file: string): Promise<Record<string, number>> {
  const chunks: Buffer[] = [];
  await new Promise<void>((ok, bad) => {
    createReadStream(file).pipe(createGunzip())
      .on("data", (c: Buffer) => chunks.push(c)).on("end", () => ok()).on("error", bad);
  });
  return JSON.parse(Buffer.concat(chunks).toString("utf8")).counts;
}

async function main(): Promise<void> {
  const live = process.env.DATABASE_URL;
  if (!live) throw new Error("DATABASE_URL is not set");
  const file = newestBackup();
  const url = scratchUrl(live);
  const env = { ...process.env, DATABASE_URL: url };

  console.log(`verifying ${file}`);
  console.log(`scratch database: ${SCRATCH_DB} (dropped at the end)`);

  await run("npx prisma migrate deploy", { env, timeout: 300_000 });
  console.log("schema applied to scratch database");

  const { stdout } = await run(`npx tsx scripts/restore-db.ts ${q(file)} --force`, {
    env,
    timeout: 900_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  console.log(stdout.trim().split(/\r?\n/).slice(-3).join(" | "));

  const expected = await counts(file);
  const db = new PrismaClient({ datasources: { db: { url } } });
  let bad = 0;
  for (const [table, want] of Object.entries(expected)) {
    const got = await (db as unknown as Record<string, { count: () => Promise<number> }>)[table]!.count();
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? "OK  " : "FAIL"} ${table.padEnd(18)} backup=${String(want).padStart(6)} restored=${String(got).padStart(6)}`);
  }
  await db.$executeRawUnsafe(`DROP DATABASE \`${SCRATCH_DB}\``);
  await db.$disconnect();
  console.log(bad === 0 ? "\nBackup verified restorable. Scratch database dropped." : `\n${bad} table(s) FAILED to restore.`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
