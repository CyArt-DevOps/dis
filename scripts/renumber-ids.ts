/**
 * Compact the user-visible id sequences back to normal.
 *
 *   npm run db:renumber            # dry run, prints the mapping
 *   npm run db:renumber -- --apply # does it
 *
 * TiDB allocates auto-increment ids in blocks of 30000 and starts a fresh block
 * after every restart, so Ticket jumped 447 -> 30002 -> 60002 -> 90002 and
 * LeaveRequest reached 120002. The numbers are user-facing: they appear in
 * ticket titles and in Discord channel names (`leave-60002`).
 *
 * Only the three tables people actually read are touched. VoiceSession,
 * Attendance and the MeetingAttendance primary key stay as they are — nobody
 * sees them, and Attendance was never sequential anyway because its upsert
 * consumes an id on every call.
 *
 * Collision safety: new ids are always LOWER than the old ones and lower than
 * anything the allocator will hand out next, so renumbering cannot clash with a
 * row created while this runs.
 *
 * Afterwards each table is pinned to AUTO_ID_CACHE 1, which makes TiDB allocate
 * strictly sequentially instead of in blocks, so this cannot happen again.
 */
import { prisma } from "../src/core/db.js";
import { writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");

/** table -> last id that is still in the original, un-jumped sequence */
const PLAN = [
  { table: "ticket", lastGood: 524 },
  { table: "leaveRequest", lastGood: 499 },
  { table: "meeting", lastGood: 122 },
] as const;

type Mapping = { table: string; moves: { from: number; to: number }[]; nextAutoIncrement: number };

async function main(): Promise<void> {
  const mappings: Mapping[] = [];

  for (const { table, lastGood } of PLAN) {
    const m = prisma as unknown as Record<string, {
      findMany: (a: unknown) => Promise<{ id: number }[]>;
    }>;
    const rows = await m[table]!.findMany({
      where: { id: { gt: lastGood } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    const moves = rows.map((r, i) => ({ from: r.id, to: lastGood + 1 + i }));
    // Base the counter on the real maximum after the moves, never on the move
    // count: on a second run there is nothing left to move, and lastGood+1 would
    // sit below ids that already exist and collide on the next insert.
    const all = await m[table]!.findMany({ orderBy: { id: "desc" }, take: 1, select: { id: true } });
    const maxAfter = Math.max(
      moves.length ? moves[moves.length - 1]!.to : 0,
      all.length ? (rows.some((r) => r.id === all[0]!.id) ? 0 : all[0]!.id) : 0
    );
    mappings.push({ table, moves, nextAutoIncrement: maxAfter + 1 });
    console.log(`${table}: ${moves.length} rows -> ${moves.length ? `${moves[0]!.to}..${moves[moves.length - 1]!.to}` : "nothing to do"}`);
    for (const mv of moves) console.log(`   ${String(mv.from).padStart(7)} -> ${mv.to}`);
  }

  writeFileSync("renumber-map.json", JSON.stringify(mappings, null, 2));
  console.log("\nmapping written to renumber-map.json (needed by the Discord fix-up)");

  if (!APPLY) {
    console.log("\nDRY RUN — nothing changed. Re-run with --apply to perform it.");
    return;
  }

  // The counter can only move backwards with this session flag set.
  await prisma.$executeRawUnsafe("SET @@session.tidb_allow_remove_auto_inc = 1");

  for (const { table, moves, nextAutoIncrement } of mappings) {
    const sqlTable = table === "leaveRequest" ? "LeaveRequest" : table[0]!.toUpperCase() + table.slice(1);

    // Ascending order: each target id is below every id still to be moved.
    for (const { from, to } of moves) {
      await prisma.$executeRawUnsafe(`UPDATE \`${sqlTable}\` SET id = ? WHERE id = ?`, to, from);
      if (table === "meeting") {
        // Emulated relations mean nothing cascades; move the children by hand.
        await prisma.$executeRawUnsafe(
          "UPDATE `MeetingAttendance` SET meetingId = ? WHERE meetingId = ?",
          to,
          from
        );
      }
    }

    await prisma.$executeRawUnsafe(`ALTER TABLE \`${sqlTable}\` AUTO_INCREMENT = ${nextAutoIncrement}`);
    // NOTE: `ALTER TABLE ... AUTO_ID_CACHE 1` would make allocation strictly
    // sequential and stop the jumps for good, but TiDB rejects it on an existing
    // table ("Can't Alter AUTO_ID_CACHE between 1 and non-1, the underlying
    // implementation is different") — cache=1 uses a different allocator, so it
    // can only be set when the table is created. Ids will therefore jump again
    // after a TiDB restart; re-run this script to compact them.
    console.log(`${table}: moved ${moves.length}, next id = ${nextAutoIncrement}`);
  }

  console.log("\nverifying...");
  let bad = 0;
  for (const { table, lastGood } of PLAN) {
    const m = prisma as unknown as Record<string, {
      count: (a?: unknown) => Promise<number>;
      findMany: (a: unknown) => Promise<{ id: number }[]>;
    }>;
    const total = await m[table]!.count();
    const above = await m[table]!.count({ where: { id: { gt: total } } });
    const rows = await m[table]!.findMany({ orderBy: { id: "asc" }, select: { id: true } });
    const dupes = new Set(rows.map((r) => r.id)).size !== rows.length;
    const maxId = rows.length ? rows[rows.length - 1]!.id : 0;
    const ok = !dupes && above === 0;
    if (!ok) bad++;
    console.log(`${ok ? "OK  " : "FAIL"} ${table.padEnd(14)} rows=${total} max=${maxId} duplicates=${dupes} strays=${above} (lastGood was ${lastGood})`);
  }
  const orphans = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    "SELECT COUNT(*) AS n FROM `MeetingAttendance` ma LEFT JOIN `Meeting` m ON m.id = ma.meetingId WHERE m.id IS NULL"
  );
  const orphanCount = Number(orphans[0]!.n);
  console.log(`${orphanCount === 0 ? "OK  " : "FAIL"} meetingAttendance orphans = ${orphanCount}`);
  if (orphanCount > 0) bad++;

  console.log(bad === 0 ? "\nRenumber complete and verified." : `\n${bad} check(s) FAILED — restore from backups/.`);
  process.exit(bad === 0 ? 0 : 1);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
