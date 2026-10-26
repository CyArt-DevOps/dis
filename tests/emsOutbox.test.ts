import { describe, it, expect, vi, beforeEach } from "vitest";

const rows: Record<string, unknown>[] = [];
vi.mock("../src/core/db.js", () => ({
  prisma: {
    outboundEvent: {
      create: vi.fn(async ({ data }) => { rows.push({ id: rows.length + 1, attempts: 0, deliveredAt: null, ...data }); }),
      findMany: vi.fn(async ({ where }: { where?: { attempts?: { lt: number } } } = {}) =>
        rows.filter((r) => !r.deliveredAt && (where?.attempts ? (r.attempts as number) < where.attempts.lt : true))),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      update: vi.fn(async ({ where, data }) => { Object.assign(rows.find((r) => r.id === where.id)!, data); }),
    },
  },
}));
const post = vi.fn();
let enabled = true;
vi.mock("../src/services/emsClient.js", () => ({ emsPost: (...a: unknown[]) => post(...a), integrationEnabled: () => enabled }));

const { EmsHttpError } = await import("../src/lib/emsErrors.js");
const { backoffMs, enqueueEvent, flushOutbox, resetPruneClockForTests, MAX_ATTEMPTS } = await import("../src/services/emsOutbox.js");
const { prisma } = await import("../src/core/db.js");

beforeEach(() => { resetPruneClockForTests(); vi.mocked(prisma.outboundEvent.deleteMany).mockClear(); rows.length = 0; post.mockReset(); enabled = true; });

describe("backoffMs", () => {
  it("follows 1m, 5m, 30m, 2h then stays at 2h", () => {
    expect([1, 2, 3, 4, 9].map(backoffMs)).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 7_200_000]);
  });
  it("clamps zero and negative attempts to the first step", () => {
    expect(backoffMs(0)).toBe(60_000);
    expect(backoffMs(-3)).toBe(60_000);
  });
});

describe("enqueueEvent", () => {
  it("is a no-op when the integration is disabled", async () => {
    enabled = false;
    await enqueueEvent("member.assigned", { id: "1" });
    expect(rows).toHaveLength(0);
  });
  it("swallows a create() failure", async () => {
    vi.mocked(prisma.outboundEvent.create).mockRejectedValueOnce(new Error("db down"));
    await expect(enqueueEvent("member.assigned", { id: "1" })).resolves.toBeUndefined();
  });
});

describe("flushOutbox", () => {
  it("delivers queued events and marks them delivered", async () => {
    await enqueueEvent("member.assigned", { id: "42" });
    post.mockResolvedValue({ ok: true });
    await flushOutbox();
    expect(post).toHaveBeenCalledWith("/events", expect.objectContaining({ type: "member.assigned", data: { id: "42" } }));
    expect(rows[0]!.deliveredAt).toBeInstanceOf(Date);
  });
  it("records the failure and schedules a retry", async () => {
    await enqueueEvent("member.assigned", { id: "42" });
    post.mockRejectedValue(new EmsHttpError(500, "boom"));
    await flushOutbox();
    expect(rows[0]!.deliveredAt).toBeNull();
    expect(rows[0]!.attempts).toBe(1);
    expect(String(rows[0]!.lastError)).toContain("boom");
    expect((rows[0]!.nextAttemptAt as Date).getTime()).toBeGreaterThan(Date.now() + 50_000);
  });
  it("records a malformed payload as a failed attempt and still delivers the next row", async () => {
    rows.push({ id: 1, attempts: 0, deliveredAt: null, eventId: "bad", type: "x", payload: "not json" });
    await enqueueEvent("member.assigned", { id: "42" });
    rows[1]!.id = 2;
    post.mockResolvedValue({ ok: true });
    await flushOutbox();
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.deliveredAt).toBeNull();
    expect((rows[0]!.nextAttemptAt as Date).getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect(post).toHaveBeenCalledTimes(1);
    expect(rows[1]!.deliveredAt).toBeInstanceOf(Date);
  });
  it("marks a permanent 4xx dead immediately", async () => {
    await enqueueEvent("member.assigned", { id: "42" });
    post.mockRejectedValue(new EmsHttpError(400, "bad payload"));
    await flushOutbox();
    expect(rows[0]!.attempts).toBe(MAX_ATTEMPTS);
    expect(String(rows[0]!.lastError)).toMatch(/^DEAD:/);
    post.mockClear();
    await flushOutbox();
    expect(post).not.toHaveBeenCalled();
  });
  it.each([408, 429, 500])("retries on %i", async (status) => {
    await enqueueEvent("member.assigned", { id: "42" });
    post.mockRejectedValue(new EmsHttpError(status, "later"));
    await flushOutbox();
    expect(rows[0]!.attempts).toBe(1);
    expect(String(rows[0]!.lastError)).not.toMatch(/^DEAD:/);
  });
  it("gives up after the maximum number of attempts", async () => {
    rows.push({ id: 1, attempts: MAX_ATTEMPTS - 1, deliveredAt: null, eventId: "e", type: "x", payload: JSON.stringify({ data: {}, occurredAt: "t" }) });
    post.mockRejectedValue(new Error("network"));
    await flushOutbox();
    expect(rows[0]!.attempts).toBe(MAX_ATTEMPTS);
    expect(String(rows[0]!.lastError)).toMatch(/^DEAD:/);
  });
  it("prunes old delivered rows at most hourly", async () => {
    await flushOutbox();
    await flushOutbox();
    expect(prisma.outboundEvent.deleteMany).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(prisma.outboundEvent.deleteMany).mock.calls[0]![0] as { where: { deliveredAt: { lt: Date } } };
    expect(arg.where.deliveredAt.lt.getTime()).toBeLessThan(Date.now() - 29 * 86_400_000);
  });
});
