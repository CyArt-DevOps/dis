import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/core/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { runShutdown } = await import("../src/core/shutdown.js");

const never = () => new Promise<void>(() => {});

function deps(over: Partial<Parameters<typeof runShutdown>[0]> = {}) {
  return {
    stopTimers: vi.fn(),
    closeSessions: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    destroyClient: vi.fn(),
    exit: vi.fn(),
    sessionsTimeoutMs: 15_000,
    disconnectTimeoutMs: 5_000,
    hardDeadlineMs: 30_000,
    ...over,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("runShutdown", () => {
  it("runs every step in order and exits 0", async () => {
    const d = deps();
    await runShutdown(d);
    expect(d.stopTimers).toHaveBeenCalled();
    expect(d.closeSessions).toHaveBeenCalled();
    expect(d.disconnect).toHaveBeenCalled();
    expect(d.destroyClient).toHaveBeenCalled();
    expect(d.exit).toHaveBeenCalledWith(0);
  });

  it("still exits when the DB disconnect hangs forever (the prod hang)", async () => {
    const d = deps({ disconnect: vi.fn(never) });
    const done = runShutdown(d);
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    expect(d.destroyClient).toHaveBeenCalled();
    expect(d.exit).toHaveBeenCalledWith(0);
  });

  it("still exits when closing sessions hangs", async () => {
    const d = deps({ closeSessions: vi.fn(never) });
    const done = runShutdown(d);
    await vi.advanceTimersByTimeAsync(15_000);
    await done;
    expect(d.disconnect).toHaveBeenCalled();
    expect(d.exit).toHaveBeenCalledWith(0);
  });

  it("hard deadline exits even if a step that should be quick never returns", async () => {
    const d = deps({ destroyClient: vi.fn(never) as never });
    void runShutdown(d);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(d.exit).toHaveBeenCalledWith(0);
  });

  it("keeps going when a step throws", async () => {
    const d = deps({
      stopTimers: vi.fn(() => { throw new Error("x"); }),
      closeSessions: vi.fn(async () => { throw new Error("db"); }),
      disconnect: vi.fn(async () => { throw new Error("db"); }),
    });
    await runShutdown(d);
    expect(d.exit).toHaveBeenCalledWith(0);
  });
});
