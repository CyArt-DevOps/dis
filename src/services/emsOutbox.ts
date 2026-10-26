import { randomUUID } from "node:crypto";
import { prisma } from "../core/db.js";
import { logger } from "../core/logger.js";
import { emsPost, integrationEnabled } from "./emsClient.js";

/**
 * Durable delivery of bot events to EMS. Writers call enqueueEvent and move on;
 * a 30s loop delivers. EMS dedupes on eventId, so a retry after a lost
 * response is harmless. EMS's 5-minute pull is the safety net behind this.
 */
const STEPS_MS = [60_000, 300_000, 1_800_000, 7_200_000];
const BATCH = 25;
const INTERVAL_MS = 30_000;

export function backoffMs(attempts: number): number {
  return STEPS_MS[Math.min(attempts, STEPS_MS.length) - 1] ?? STEPS_MS[0]!;
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
  const due = await prisma.outboundEvent.findMany({
    where: { deliveredAt: null, nextAttemptAt: { lte: new Date() } },
    orderBy: { id: "asc" },
    take: BATCH,
  });
  for (const row of due) {
    const { data, occurredAt } = JSON.parse(row.payload) as { data: unknown; occurredAt: string };
    try {
      await emsPost("/events", { id: row.eventId, type: row.type, occurredAt, data });
      await prisma.outboundEvent.update({ where: { id: row.id }, data: { deliveredAt: new Date(), lastError: null } });
    } catch (err) {
      const attempts = row.attempts + 1;
      await prisma.outboundEvent.update({
        where: { id: row.id },
        data: { attempts, lastError: String((err as Error).message).slice(0, 1000), nextAttemptAt: new Date(Date.now() + backoffMs(attempts)) },
      });
      logger.warn({ eventId: row.eventId, attempts, err: (err as Error).message }, "EMS event delivery failed");
    }
  }
}

let timer: NodeJS.Timeout | null = null;
export function startOutbox(): void {
  if (timer || !integrationEnabled()) return;
  timer = setInterval(() => void flushOutbox().catch((err) => logger.warn({ err }, "EMS outbox flush failed")), INTERVAL_MS);
}
export function stopOutbox(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
