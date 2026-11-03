/**
 * Correct Attendance rows that overlapping voice sweeps over-credited.
 *
 *   npm run db:repair-hours                      dry run, 2026-10-14 to yesterday
 *   npm run db:repair-hours -- --to 2026-11-03   choose the last day (or --from)
 *   npm run db:repair-hours -- --apply           write the changes
 *
 * Real time comes from VoiceSession join/leave times, which the bug never
 * touched. Rows are only ever LOWERED, and only when over by more than a minute,
 * so a day that was under-credited for another reason is left alone. Each write
 * checks the row still holds the value that was read, and the bot can stay up: a
 * row that moved is reported and picked up by running this again.
 *
 * --apply first saves every change to backups/hours-repair-<ts>.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { org } from "../src/config/loader.js";
import { prisma } from "../src/core/db.js";
import { realSecondsByDay, type SessionSpan } from "../src/lib/voiceHours.js";
import { shiftDayKey, tzDateKey, tzDayStartUtc } from "../src/lib/time.js";
import { MAX_SESSION_SECONDS } from "../src/services/attendance.js";

const DEFAULT_FROM = "2026-10-14";
const TOLERANCE_SECONDS = 60;
const BATCH = 25;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const hours = (s: number) => Math.round((s / 3600) * 10) / 10;

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const from = arg("--from") ?? DEFAULT_FROM;
  const to = arg("--to") ?? shiftDayKey(tzDateKey(new Date()), -1);
  const required = Math.round(org.attendancePolicy.minHours * 3600);

  const rows = await prisma.attendance.findMany({
    where: { day: { gte: from, lte: to } },
    select: { guildId: true, userId: true, day: true, seconds: true },
  });
  const sessions = await prisma.voiceSession.findMany({
    where: {
      joinedAt: { lt: tzDayStartUtc(shiftDayKey(to, 1)) },
      OR: [{ leftAt: null }, { leftAt: { gt: new Date(tzDayStartUtc(from).getTime() - MAX_SESSION_SECONDS * 1000) } }],
    },
    select: { guildId: true, userId: true, joinedAt: true, leftAt: true, creditedUpTo: true },
  });

  const byMember = new Map<string, SessionSpan[]>();
  for (const s of sessions) {
    const key = s.guildId + "|" + s.userId;
    byMember.set(key, [...(byMember.get(key) ?? []), s]);
  }
  const real = new Map<string, Map<string, number>>();
  for (const [key, spans] of byMember) real.set(key, realSecondsByDay(spans, MAX_SESSION_SECONDS));

  const changes: { guildId: string; userId: string; day: string; before: number; after: number }[] = [];
  const days = new Map<string, { rows: number; before: number; after: number; changed: number; tenBefore: number; tenAfter: number; metBefore: number; metAfter: number }>();
  for (const r of rows) {
    const actual = real.get(r.guildId + "|" + r.userId)?.get(r.day) ?? 0;
    const after = r.seconds - actual > TOLERANCE_SECONDS ? actual : r.seconds;
    if (after !== r.seconds) changes.push({ guildId: r.guildId, userId: r.userId, day: r.day, before: r.seconds, after });
    const d = days.get(r.day) ?? { rows: 0, before: 0, after: 0, changed: 0, tenBefore: 0, tenAfter: 0, metBefore: 0, metAfter: 0 };
    d.rows++;
    d.before += r.seconds;
    d.after += after;
    if (after !== r.seconds) d.changed++;
    if (r.seconds >= 10 * 3600) d.tenBefore++;
    if (after >= 10 * 3600) d.tenAfter++;
    if (r.seconds >= required) d.metBefore++;
    if (after >= required) d.metAfter++;
    days.set(r.day, d);
  }

  console.log(`${apply ? "APPLY" : "DRY RUN"} ${from} to ${to}, target ${org.attendancePolicy.minHours}h`);
  console.table(
    [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .filter(([, d]) => d.changed > 0)
      .map(([day, d]) => ({
        day,
        members: d.rows,
        changed: d.changed,
        hoursBefore: hours(d.before),
        hoursAfter: hours(d.after),
        "10h+Before": d.tenBefore,
        "10h+After": d.tenAfter,
        metBefore: d.metBefore,
        metAfter: d.metAfter,
      }))
  );
  console.log(`${changes.length} of ${rows.length} rows would change`);

  if (apply && changes.length > 0) {
    const dir = resolve(process.cwd(), "backups");
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `hours-repair-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify(changes));
    console.log(`Saved the changes to ${file}`);

    let written = 0;
    let moved = 0;
    for (let i = 0; i < changes.length; i += BATCH) {
      await Promise.all(
        changes.slice(i, i + BATCH).map(async (c) => {
          const res = await prisma.attendance.updateMany({
            where: { guildId: c.guildId, userId: c.userId, day: c.day, seconds: c.before },
            data: { seconds: c.after },
          });
          if (res.count === 1) written++;
          else moved++;
        })
      );
    }
    console.log(`Corrected ${written} rows; ${moved} moved while running (run again to pick them up)`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
