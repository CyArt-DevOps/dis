import { randomUUID } from "node:crypto";
import { prisma } from "../core/db.js";
import { logger } from "../core/logger.js";
import { isRetryableEmsError } from "../lib/emsErrors.js";
import { emsPost, integrationEnabled } from "./emsClient.js";

/**
 * Durable delivery of bot events to EMS. Writers call enqueueEvent and move on;
 * a 30s loop delivers. EMS dedupes on eventId, so a retry after a lost
 * response is harmless. EMS's 5-minute pull is the safety net behind this.
 */
const STEPS_MS = [60_000, 300_000, 1_800_000, 7_200_000];
const BATCH = 25;
/** Rows at this many attempts are dead: never selected again, kept for inspection. */
export const MAX_ATTEMPTS = 20;
const PRUNE_EVERY_MS = 3_600_000;
const KEEP_DELIVERED_MS = 30 * 86_400_000;
let lastPrune = 0;
export function resetPruneClockForTests(): void {
  lastPrune = 0;
}

async function pruneDelivered(): Promise<void> {
  if (Date.now() - lastPrune < PRUNE_EVERY_MS) return;
  lastPrune = Date.now();
  try {
    await prisma.outboundEvent.deleteMany({ where: { deliveredAt: { lt: new Date(Date.now() - KEEP_DELIVERED_MS) } } });
  } catch (err) {
    logger.warn({ err }, "EMS outbox prune failed");
  }
}
const INTERVAL_MS = 30_000;

export function backoffMs(attempts: number): number {
  // Clamp both ends: 0/negative attempts get the first step, large ones the last.
  const i = Math.min(Math.max(attempts, 1), STEPS_MS.length) - 1;
  return STEPS_MS[i]!;
}

export async function enqueueEvent(type: string, data: unknown): Promise<void> {
  if (!integrationEnabled()) return;
  try {
    await prisma.outboundEvent.create({
      data: { eventId: randomUUID(), type, payload: JSON.stringify({ data, occurredAt: new Date().toISOString() }) },
    });
  } catch (err) {
    // Never let the integration break the Discord flow that triggered it.
    logger.warn({ err, type }, "EMS outbox enqueue failed");
  }
}

export async function flushOutbox(): Promise<void> {
  await pruneDelivered();
  const due = await prisma.outboundEvent.findMany({
    where: { deliveredAt: null, attempts: { lt: MAX_ATTEMPTS }, nextAttemptAt: { lte: new Date() } },
    orderBy: { id: "asc" },
    take: BATCH,
  });
  for (const row of due) {
    try {
      // Parsed inside the try so one corrupt row backs off instead of blocking the queue.
      const { data, occurredAt } = JSON.parse(row.payload) as { data: unknown; occurredAt: string };
      await emsPost("/events", { id: row.eventId, type: row.type, occurredAt, data });
      await prisma.outboundEvent.update({ where: { id: row.id }, data: { deliveredAt: new Date(), lastError: null } });
    } catch (err) {
      const message = String((err as Error).message);
      // A permanent 4xx will never succeed; park it at the cap instead of retrying.
      const attempts = isRetryableEmsError(err) ? row.attempts + 1 : MAX_ATTEMPTS;
      const dead = attempts >= MAX_ATTEMPTS;
      logger.warn({ eventId: row.eventId, attempts, dead, err: message }, "EMS event delivery failed");
      try {
        await prisma.outboundEvent.update({
          where: { id: row.id },
          data: { attempts, lastError: `${dead ? "DEAD: " : ""}${message}`.slice(0, 1000), nextAttemptAt: new Date(Date.now() + backoffMs(attempts)) },
        });
      } catch (updateErr) {
        // A DB hiccup recording the failure must not strand the rest of the batch.
        logger.warn({ eventId: row.eventId, err: updateErr }, "EMS outbox failure bookkeeping failed");
      }
    }
  }
}

let timer: NodeJS.Timeout | null = null;
// A slow EMS can make a flush outlast the interval; an overlapping flush would
// re-read the same undelivered rows and resend them.
let flushing = false;
export function startOutbox(): void {
  if (timer || !integrationEnabled()) return;
  timer = setInterval(() => {
    if (flushing) return;
    flushing = true;
    void flushOutbox()
      .catch((err) => logger.warn({ err }, "EMS outbox flush failed"))
      .finally(() => { flushing = false; });
  }, INTERVAL_MS);
}
export function stopOutbox(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
