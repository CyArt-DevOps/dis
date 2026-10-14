/**
 * Make the user-visible id sequences strictly sequential, permanently.
 *
 *   npm run db:fix-autoid            # dry run, prints the DDL it would run
 *   npm run db:fix-autoid -- --apply
 *
 * TiDB hands each node a block of 30000 auto-increment ids and starts a fresh
 * block after every restart, which is why Ticket ran 447 -> 30002 -> 60002.
 * `AUTO_ID_CACHE 1` switches that table to a centralised allocator that issues
 * ids one at a time — but it cannot be turned on afterwards:
 *
 *     Can't Alter AUTO_ID_CACHE between 1 and non-1,
 *     the underlying implementation is different
 *
 * It can only be chosen when the table is created. So each table is recreated
 * with the option set and its rows copied across:
 *
 *   CREATE TABLE X__new (… same DDL …) AUTO_ID_CACHE = 1
 *   INSERT INTO X__new SELECT * FROM X
 *   verify row count and max(id)
 *   RENAME TABLE X TO X__old, X__new TO X      (atomic)
 *   DROP TABLE X__old                          (only after verification)
 *
 * RUN WITH EVERY BOT STOPPED. Rows written between the copy and the rename
 * would land in the old table and be discarded.
 *
 * Only the three tables people read are converted. The internal ones are far
 * larger and their ids are never shown.
 */
import { prisma } from "../src/core/db.js";

const APPLY = process.argv.includes("--apply");
const TABLES = ["Ticket", "LeaveRequest", "Meeting"] as const;

async function raw<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return prisma.$queryRawUnsafe<T[]>(sql);
}
async function exec(sql: string): Promise<void> {
  await prisma.$executeRawUnsafe(sql);
}
const num = (v: unknown): number => Number(v ?? 0);

async function stats(table: string): Promise<{ rows: number; maxId: number; cache: string }> {
  const [c] = await raw<{ n: bigint }>(`SELECT COUNT(*) AS n FROM \`${table}\``);
  const [m] = await raw<{ m: number | null }>(`SELECT MAX(id) AS m FROM \`${table}\``);
  const [d] = await raw<Record<string, string>>(`SHOW CREATE TABLE \`${table}\``);
  const ddl = Object.values(d!)[1] ?? "";
  return {
    rows: num(c!.n),
    maxId: num(m!.m),
    cache: /AUTO_ID_CACHE[= ]+(\d+)/i.exec(ddl)?.[1] ?? "default (30000 blocks)",
  };
}

async function main(): Promise<void> {
  for (const table of TABLES) {
    const before = await stats(table);
    console.log(`\n=== ${table} ===`);
    console.log(`before: rows=${before.rows} max(id)=${before.maxId} AUTO_ID_CACHE=${before.cache}`);
    if (before.cache === "1") {
      console.log("already sequential — skipping");
      continue;
    }

    const [d] = await raw<Record<string, string>>(`SHOW CREATE TABLE \`${table}\``);
    let ddl = Object.values(d!)[1]!;
    // Point the DDL at the staging table and give it the option we are after.
    ddl = ddl.replace(/^CREATE TABLE `[^`]+`/, `CREATE TABLE \`${table}__new\``);
    ddl = ddl.replace(/\s*AUTO_INCREMENT=\d+/i, "");
    ddl = `${ddl} AUTO_ID_CACHE = 1`;

    if (!APPLY) {
      console.log("would run:\n" + ddl.split("\n").slice(-1)[0]);
      console.log(`would copy ${before.rows} rows, then RENAME and drop the old table`);
      continue;
    }

    await exec(`DROP TABLE IF EXISTS \`${table}__new\``);
    await exec(ddl);
    await exec(`INSERT INTO \`${table}__new\` SELECT * FROM \`${table}\``);

    const [c2] = await raw<{ n: bigint }>(`SELECT COUNT(*) AS n FROM \`${table}__new\``);
    const [m2] = await raw<{ m: number | null }>(`SELECT MAX(id) AS m FROM \`${table}__new\``);
    if (num(c2!.n) !== before.rows || num(m2!.m) !== before.maxId) {
      console.error(
        `COPY MISMATCH for ${table}: ${num(c2!.n)}/${num(m2!.m)} vs ${before.rows}/${before.maxId} — aborting, nothing renamed`
      );
      process.exit(1);
    }

    // The counter has to continue above the highest row.
    await exec("SET @@session.tidb_allow_remove_auto_inc = 1");
    await exec(`ALTER TABLE \`${table}__new\` AUTO_INCREMENT = ${before.maxId + 1}`);

    // Atomic swap: nothing ever sees a missing table.
    await exec(`RENAME TABLE \`${table}\` TO \`${table}__old\`, \`${table}__new\` TO \`${table}\``);

    const after = await stats(table);
    if (after.rows !== before.rows || after.maxId !== before.maxId) {
      console.error(`POST-RENAME MISMATCH for ${table} — old table kept as ${table}__old`);
      process.exit(1);
    }
    await exec(`DROP TABLE \`${table}__old\``);
    console.log(`after:  rows=${after.rows} max(id)=${after.maxId} AUTO_ID_CACHE=${after.cache}`);
  }

  if (!APPLY) console.log("\nDRY RUN — nothing changed. Re-run with --apply.");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
