import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/core/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

const mod = await import("../src/services/memberCache.js");

beforeEach(() => { vi.useFakeTimers(); mod.resetMemberCacheForTests(); });
afterEach(() => vi.useRealTimers());

describe("memberCache", () => {
  it("is not ready until marked", () => {
    expect(mod.membersReady()).toBe(false);
    mod.markMembersReady();
    expect(mod.membersReady()).toBe(true);
  });
  it("warmMemberCache marks ready on success", async () => {
    const fetch = vi.fn().mockResolvedValue(undefined);
    await mod.warmMemberCache({ members: { fetch } } as never);
    expect(mod.membersReady()).toBe(true);
  });
  it("retries with backoff on failure then marks ready", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("x")).mockRejectedValueOnce(new Error("x")).mockResolvedValue(undefined);
    await mod.warmMemberCache({ members: { fetch } } as never);
    expect(mod.membersReady()).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mod.membersReady()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(mod.membersReady()).toBe(true);
  });
  it("caps the delay at 10 minutes", () => {
    expect([0, 1, 2, 5, 20].map(mod.warmDelayMs)).toEqual([30_000, 60_000, 120_000, 600_000, 600_000]);
  });
});
