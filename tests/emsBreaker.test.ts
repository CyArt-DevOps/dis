import { describe, expect, it } from "vitest";
import { COOLDOWN_MS, EmsBreaker, EmsCoolingDown, isBlockedFailure } from "../src/lib/emsBreaker.js";
import { EmsHttpError } from "../src/lib/emsErrors.js";

const reset = () => new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
const challenge = () => new EmsHttpError(403, "<html>Bot Verification lsrecaptcha-form</html>");

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, add: (ms: number) => (t += ms) };
}

describe("isBlockedFailure", () => {
  it("counts host blocks, not our app's answers", () => {
    expect(isBlockedFailure(reset())).toBe(true);
    expect(isBlockedFailure(challenge())).toBe(true);
    expect(isBlockedFailure(new EmsHttpError(503, "down"))).toBe(true);
    expect(isBlockedFailure(new EmsHttpError(401, '{"message":"bad signature"}'))).toBe(false);
    expect(isBlockedFailure(new EmsHttpError(500, "{}"))).toBe(false);
  });
});

describe("EmsBreaker", () => {
  it("opens after 3 blocked failures in a minute and pauses calls", () => {
    const c = clock();
    const events: string[] = [];
    const b = new EmsBreaker(c.now, (e) => events.push(e.type));
    for (let k = 0; k < 3; k++) {
      expect(b.before()).toBe(false);
      b.failure(reset(), false);
      c.add(5_000);
    }
    expect(events).toEqual(["opened"]);
    expect(() => b.before()).toThrow(EmsCoolingDown);
    expect(b.pausedUntil()).not.toBeNull();
  });

  it("does not open for failures spread over more than a minute", () => {
    const c = clock();
    const b = new EmsBreaker(c.now);
    for (let k = 0; k < 5; k++) {
      b.before();
      b.failure(challenge(), false);
      c.add(31_000);
    }
    expect(b.before()).toBe(false);
  });

  it("an answer from our app resets the count", () => {
    const c = clock();
    const b = new EmsBreaker(c.now);
    b.failure(reset(), false);
    b.failure(reset(), false);
    b.failure(new EmsHttpError(401, "{}"), false);
    b.failure(reset(), false);
    expect(b.before()).toBe(false);
  });

  it("after the cooldown lets one probe through; success closes", () => {
    const c = clock();
    const events: string[] = [];
    const b = new EmsBreaker(c.now, (e) => events.push(e.type));
    for (let k = 0; k < 3; k++) b.failure(reset(), false);
    c.add(COOLDOWN_MS + 1);
    expect(b.before()).toBe(true); // the probe
    expect(() => b.before()).toThrow(EmsCoolingDown); // others wait while it runs
    b.success();
    expect(events).toEqual(["opened", "closed"]);
    expect(b.before()).toBe(false);
  });

  it("a failed probe pauses for another cooldown", () => {
    const c = clock();
    const b = new EmsBreaker(c.now);
    for (let k = 0; k < 3; k++) b.failure(reset(), false);
    c.add(COOLDOWN_MS + 1);
    const probe = b.before();
    b.failure(challenge(), probe);
    expect(() => b.before()).toThrow(EmsCoolingDown);
    c.add(COOLDOWN_MS - 1000);
    expect(() => b.before()).toThrow(EmsCoolingDown);
  });
});
