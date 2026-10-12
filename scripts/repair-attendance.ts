/**
 * Repair Attendance days inflated by the old tracking bug (sessions left open
 * across bot downtime were credited full elapsed spans — producing impossible
 * daily totals like 34h).
 *
 * Both the Attendance rows AND the raw VoiceSession rows are polluted (the old
 * dangling/boot logic wrote inflated `seconds` and pushed `leftAt` to boot
 * time), so there is no clean source to rebuild true values from. The only
 * safe, defensible correction is a CLAMP: any day above a realistic maximum is
 * certainly inflated, so cap it; believable rows are left untouched. Clamping
 * only ever lowers a value, so it can never invent presence.
 *
 *   MAX_HOURS=12 DRY_RUN=1 npx tsx scripts/repair-attendance.ts   # report
 *   npx tsx scripts/repair-attendance.ts                          # apply (12h cap)
 *
 * MAX_HOURS default 12 — well above the ~6h working window, so real presence is
 * never touched; only artifacts (>12h/day) are capped.
 */
import { prisma } from "../src/core/db.js";

const HOUR = 3600;
const MAX_HOURS = Number(process.env.MAX_HOURS ?? 12);
const CAP = Math.round(MAX_HOURS * HOUR);
const DRY = process.env.DRY_RUN === "1";

async function main() {
  const rows = await prisma.attendance.findMany();
  const over = rows.filter((r) => r.seconds > CAP).sort((a, b) => b.seconds - a.seconds);

  console.log(
    `${DRY ? "[DRY RUN] " : ""}Attendance clamp @ ${MAX_HOURS}h:\n` +
      `  total rows:      ${rows.length}\n` +
      `  inflated (>${MAX_HOURS}h): ${over.length}\n` +
      `  max seen:        ${(Math.max(0, ...rows.map((r) => r.seconds)) / HOUR).toFixed(1)}h`
  );
  for (const r of over.slice(0, 20))
    console.log(`    ${r.userId} ${r.day}: ${(r.seconds / HOUR).toFixed(1)}h -> ${MAX_HOURS}h`);
  if (over.length > 20) console.log(`    …and ${over.length - 20} more`);

  if (!DRY) {
    for (const r of over) {
      await prisma.attendance.update({
        where: { guildId_userId_day: { guildId: r.guildId, userId: r.userId, day: r.day } },
        data: { seconds: CAP },
      });
    }
    console.log(`  clamped ${over.length} row(s).`);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("repair-attendance failed:", err);
  process.exit(1);
});
