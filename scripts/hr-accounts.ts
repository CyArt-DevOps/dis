/**
 * Manage HR sign-off accounts for the dashboard.
 *
 *   npm run hr -- list
 *   npm run hr -- add "Priya Sharma"      # prints a generated password ONCE
 *   npm run hr -- reset "Priya Sharma"    # new password, re-enables the account
 *   npm run hr -- disable "Priya Sharma"  # takes effect immediately
 *   npm run hr -- enable "Priya Sharma"
 *
 * Passwords are generated (never chosen) and stored only as scrypt hashes.
 * Runs against whatever DATABASE_URL .env points at.
 */
import { connectDb, disconnectDb } from "../src/core/db.js";
import { createHr, listHr, resetHr, setHrActive } from "../src/services/hrUsers.js";

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const name = rest.join(" ").trim();
  await connectDb();
  try {
    if (cmd === "list") {
      const rows = await listHr();
      if (!rows.length) console.log("No HR accounts yet. Add one with: npm run hr -- add \"Name\"");
      for (const r of rows) {
        console.log(
          `${r.active ? "active  " : "disabled"}  ${r.name.padEnd(28)} last used ${r.lastUsedAt ? r.lastUsedAt.toISOString() : "never"}`
        );
      }
    } else if (cmd === "add" && name) {
      const pw = await createHr(name);
      console.log(`\nCreated HR account "${name}".\nPassword (shown once, share privately): ${pw}\n`);
    } else if (cmd === "reset" && name) {
      const pw = await resetHr(name);
      console.log(`\nNew password for "${name}" (shown once): ${pw}\n`);
    } else if ((cmd === "disable" || cmd === "enable") && name) {
      await setHrActive(name, cmd === "enable");
      console.log(`${name}: ${cmd}d`);
    } else {
      console.log('Usage: npm run hr -- list | add "Name" | reset "Name" | disable "Name" | enable "Name"');
      process.exitCode = 1;
    }
  } finally {
    await disconnectDb();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
