/**
 * Keep the bot running.
 *
 *   npm run start:supervised
 *
 * While the bot lives on a laptop rather than a host, nothing brings it back
 * after a crash, a dropped connection it cannot recover from, or an unhandled
 * rejection. Attendance then stops being recorded and nobody notices until
 * someone checks. This restarts it, backs off if it is crash-looping, and keeps
 * a log of every exit so the cause is still there tomorrow.
 *
 * Ctrl+C stops supervision and forwards the signal, so the bot still closes its
 * open voice sessions on the way out instead of leaving them dangling.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const ENTRY = resolve(process.cwd(), "dist/index.js");
const LOG_DIR = resolve(process.cwd(), "logs");
const MIN_DELAY_MS = 2_000;
const MAX_DELAY_MS = 60_000;
/** A run this long counts as healthy, so the next crash starts backoff over. */
const HEALTHY_MS = 120_000;

if (!existsSync(ENTRY)) {
  console.error(`Missing ${ENTRY}. Run \`npm run build\` first.`);
  process.exit(1);
}
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

const logFile = resolve(LOG_DIR, `bot-${new Date().toISOString().slice(0, 10)}.log`);
const log = createWriteStream(logFile, { flags: "a" });

function note(msg) {
  const line = `[supervisor ${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  log.write(line);
}

let delay = MIN_DELAY_MS;
let child = null;
let stopping = false;

function start() {
  const startedAt = Date.now();
  child = spawn(process.execPath, [ENTRY], { stdio: ["ignore", "pipe", "pipe"] });

  child.stdout.on("data", (d) => {
    process.stdout.write(d);
    log.write(d);
  });
  child.stderr.on("data", (d) => {
    process.stderr.write(d);
    log.write(d);
  });

  child.on("exit", (code, signal) => {
    const ranMs = Date.now() - startedAt;
    child = null;
    if (stopping) {
      note(`bot exited (${signal ?? code}) during shutdown; supervisor stopping`);
      log.end();
      process.exit(0);
    }
    // A long healthy run means this crash is not a startup loop.
    if (ranMs >= HEALTHY_MS) delay = MIN_DELAY_MS;
    note(`bot exited (code=${code} signal=${signal}) after ${Math.round(ranMs / 1000)}s — restarting in ${delay / 1000}s`);
    setTimeout(start, delay);
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  });
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    note(`${sig} received — asking the bot to shut down`);
    if (child) child.kill(sig);
    else process.exit(0);
    // If it will not go quietly, do not hang the terminal forever.
    setTimeout(() => {
      if (child) child.kill("SIGKILL");
      process.exit(0);
    }, 15_000).unref();
  });
}

note(`supervising ${ENTRY}; logging to ${logFile}`);
start();
