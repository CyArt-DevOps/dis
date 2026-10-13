/**
 * Write a single-file, consistent copy of the database to `prisma/data/snapshot/app.db`.
 *
 * Copying `app.db` by hand is a trap: the bot runs SQLite in WAL mode, so recent
 * writes live in `app.db-wal` and a plain copy silently loses them. `VACUUM INTO`
 * folds the WAL in and compacts free pages, producing one file that is safe to
 * upload to the host.
 *
 * Run with the bot STOPPED for a snapshot that is current, not merely consistent.
 *
 *   npm run db:snapshot
 */
import { mkdirSync, existsSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { prisma } from "../src/core/db.js";

const out = resolve(process.cwd(), "prisma/data/snapshot/app.db");
mkdirSync(dirname(out), { recursive: true });
for (const f of [out, `${out}-wal`, `${out}-shm`]) if (existsSync(f)) rmSync(f);

await prisma.$executeRawUnsafe(`VACUUM INTO '${out.replace(/\\/g, "/")}'`);
await prisma.$disconnect();

const mb = (statSync(out).size / 1024 / 1024).toFixed(2);
console.log(`Snapshot written: ${out} (${mb} MB)`);
console.log("Upload this single file to prisma/data/app.db on the host.");
