import { describe, it, expect, vi, beforeEach } from "vitest";

const rows: Record<string, unknown>[] = [];
vi.mock("../src/core/db.js", () => ({
  prisma: {
    outboundEvent: {
      create: vi.fn(async ({ data }) => { rows.push({ id: rows.length + 1, attempts: 0, deliveredAt: null, ...data }); }),
      findMany: vi.fn(async () => rows.filter((r) => !r.deliveredAt)),
      update: vi.fn(async ({ where, data }) => { Object.assign(rows.find((r) => r.id === where.id)!, data); }),
    },
  },
}));
const post = vi.fn();
vi.mock("../src/services/emsClient.js", () => ({ emsPost: (...a: unknown[]) => post(...a), integrationEnabled: () => true }));

const { backoffMs, enqueueEvent, flushOutbox } = await import("../src/services/emsOutbox.js");

beforeEach(() => { rows.length = 0; post.mockReset(); });

describe("backoffMs", () => {
  it("follows 1m, 5m, 30m, 2h then stays at 2h", () => {
    expect([1, 2, 3, 4, 9].map(backoffMs)).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 7_200_000]);
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
    post.mockRejectedValue(new Error("EMS 500: boom"));
    await flushOutbox();
    expect(rows[0]!.deliveredAt).toBeNull();
    expect(rows[0]!.attempts).toBe(1);
    expect(String(rows[0]!.lastError)).toContain("boom");
    expect((rows[0]!.nextAttemptAt as Date).getTime()).toBeGreaterThan(Date.now() + 50_000);
  });
});
