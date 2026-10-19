import { Events } from "discord.js";
import { setBotClient } from "./core/botClient.js";
import { startWarningSweep, stopWarningSweep, warningAckHandler } from "./services/warnings.js";
import { ensureHoursPanels, hoursButtonHandler, hoursCommand } from "./services/voiceSummary.js";
import { syncGuildCommands } from "./services/commandSync.js";
import { startHoursDigest, stopHoursDigest } from "./services/hoursDigest.js";
import { env } from "./config/env.js";
import { createClient } from "./core/client.js";
import { logger } from "./core/logger.js";
import { registry } from "./core/registry.js";
import { registerAllCommands } from "./commands/index.js";
import { registerReady } from "./events/ready.js";
import { registerInteractionCreate } from "./events/interactionCreate.js";
import { registerGuildMemberAdd } from "./events/guildMemberAdd.js";
import { registerLogging } from "./events/logging.js";
import { registerVoiceTracking } from "./events/voiceTracking.js";
import {
  closeAllOpenSessions,
  closeStaleSessionsOnBoot,
  reopenActiveSessions,
  startAttendanceSweep,
  stopAttendanceSweep,
} from "./services/attendance.js";
import { initMeetings, restoreGrants } from "./services/meeting.js";
import { setMeetingHooks, startScheduler, stopScheduler } from "./services/meetingScheduler.js";
import {
  handleMeetingEnd,
  handleMeetingStart,
  handleMeetingTick,
  initMeetingAttendance,
} from "./services/meetingAttendance.js";
import { leaveHandlers } from "./interactions/leave.js";
import { startMonthlySummary, stopMonthlySummary } from "./services/monthlySummary.js";
import { verificationHandlers } from "./interactions/verification.js";
import { ticketHandlers } from "./interactions/tickets.js";
import { startTicketArchiveSweep, stopTicketArchiveSweep } from "./services/tickets.js";
import {
  startScheduledMessages,
  stopScheduledMessages,
} from "./services/scheduledMessages.js";
import { projectWizardHandler } from "./interactions/project.js";
import { meetingPeopleSelectHandler } from "./interactions/meetingPeople.js";
import { scheduleModalHandler } from "./interactions/schedule.js";
import { connectDb, disconnectDb } from "./core/db.js";
import { startDashboard, stopDashboard } from "./web/server.js";

/**
 * Apply pending migrations before the first query.
 *
 * The hosting panel runs `node dist/index.js` directly — never `npm start` — so
 * there is no other hook where migrations can run on the server. Doing it here
 * also means .env is already loaded, which `prisma migrate deploy` needs and
 * npm's postinstall cannot rely on.
 *
 * A failure is logged but not fatal: an unreachable migration step should not
 * keep an otherwise-healthy bot offline, and the schema is usually already current.
 */
async function applyMigrations(): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { createRequire } = await import("node:module");
  try {
    // Run the Prisma CLI through this node binary instead of npx: Node refuses to
    // spawn .cmd shims on Windows without a shell (spawn EINVAL), and skipping npx
    // also avoids its slow package resolution on every boot.
    const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [prismaCli, "migrate", "deploy"],
      { cwd: process.cwd(), timeout: 120_000 }
    );
    logger.info({ out: stdout.trim().split(/\r?\n/).slice(-2).join(" ") }, "Migrations applied");
  } catch (err) {
    logger.error({ err }, "Migration step failed — continuing with the existing schema");
  }
}

async function main() {
  await applyMigrations();
  await connectDb();
  registerAllCommands();
  for (const h of verificationHandlers) registry.registerHandler(h);
  for (const h of ticketHandlers) registry.registerHandler(h);
  for (const h of leaveHandlers) registry.registerHandler(h);
  registry.registerHandler(projectWizardHandler);
  registry.registerHandler(meetingPeopleSelectHandler);
  registry.registerHandler(scheduleModalHandler);
  registry.registerHandler(warningAckHandler);
  registry.registerHandler(hoursButtonHandler);
  registry.registerCommand(hoursCommand);

  await closeStaleSessionsOnBoot();

  const client = createClient();
  initMeetings(client);
  registerReady(client);
  registerInteractionCreate(client);
  registerGuildMemberAdd(client);
  registerLogging(client);
  registerVoiceTracking(client);

  initMeetingAttendance(client);
  setMeetingHooks({
    onStart: handleMeetingStart,
    onTick: handleMeetingTick,
    onEnd: handleMeetingEnd,
  });

  client.once(Events.ClientReady, () => {
    setBotClient(client);
    void reopenActiveSessions(client).then(() => startAttendanceSweep(client));
    startWarningSweep(client);
    startHoursDigest(client);
    // Private "Check my hours" panel in each project's #general, and push the
    // slash command list so new commands (like /hours) appear without a manual register.
    for (const g of client.guilds.cache.values()) {
      void ensureHoursPanels(g).catch((err) => logger.warn({ err }, "Hours panel check failed"));
    }
    void syncGuildCommands().catch((err) => logger.warn({ err }, "Slash command sync failed"));
    void restoreGrants();
    startScheduler(client);
    startMonthlySummary(client);
    startTicketArchiveSweep(client);
    startScheduledMessages(client);
    void startDashboard();
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    stopScheduler();
    stopMonthlySummary();
    stopTicketArchiveSweep();
    stopWarningSweep();
    stopHoursDigest();
    stopScheduledMessages();
    stopAttendanceSweep();
    stopDashboard();
    // Credit + close active voice sessions before the DB closes, so a deploy
    // doesn't leave dangling sessions that accrue downtime on the next boot.
    // Bounded: the host kills a process that doesn't stop promptly, and boot
    // recovery closes whatever is left from the last checkpoint anyway.
    await Promise.race([
      closeAllOpenSessions().catch((err) => logger.error({ err }, "Failed closing voice sessions on shutdown")),
      new Promise((r) => setTimeout(r, 15_000)),
    ]);
    await disconnectDb().catch(() => {});
    client.destroy();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled rejection");
  });

  await loginWithRetry(client);
}

/**
 * Retry the INITIAL gateway login on transient network errors (connect timeout,
 * DNS/reset) with capped exponential backoff. discord.js handles reconnects on
 * its own once logged in — it's only this first login that used to crash the
 * whole process on a single blip, taking every interaction down with it until a
 * human restarted the bot. An auth error (bad token) is not transient: fail fast.
 */
async function loginWithRetry(client: import("discord.js").Client): Promise<void> {
  const MAX_DELAY_MS = 60_000;
  let attempt = 0;
  for (;;) {
    try {
      await client.login(env.DISCORD_TOKEN);
      return;
    } catch (err) {
      const code = (err as { code?: string | number })?.code;
      if (code === "TokenInvalid" || code === 401) throw err; // not transient
      attempt += 1;
      const delay = Math.min(1000 * 2 ** (attempt - 1), MAX_DELAY_MS);
      logger.warn({ err, attempt, delayMs: delay }, "Gateway login failed — retrying");
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
