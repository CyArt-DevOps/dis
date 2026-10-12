import { describe, it, expect } from "vitest";
import { shiftDayKey, splitByTzDay, tzDateKey, tzDayStartUtc } from "../src/lib/time.js";

// Org timezone is Asia/Kolkata (UTC+5:30) — local midnight is 18:30 UTC.

describe("shiftDayKey", () => {
  it("moves forward and backward across month ends", () => {
    expect(shiftDayKey("2026-07-31", 1)).toBe("2026-08-01");
    expect(shiftDayKey("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDayKey("2026-07-15", -6)).toBe("2026-07-09");
  });
});

describe("tzDayStartUtc", () => {
  it("returns the UTC instant of local midnight", () => {
    expect(tzDayStartUtc("2026-07-31").toISOString()).toBe("2026-07-30T18:30:00.000Z");
  });
});

describe("tzDateKey", () => {
  it("buckets by LOCAL day, not UTC day", () => {
    // 20:00 UTC on the 30th is already 01:30 on the 31st in IST.
    expect(tzDateKey(new Date("2026-07-30T20:00:00Z"))).toBe("2026-07-31");
    expect(tzDateKey(new Date("2026-07-30T18:00:00Z"))).toBe("2026-07-30");
  });
});

describe("splitByTzDay", () => {
  it("keeps a session inside one local day in one bucket", () => {
    const out = splitByTzDay(
      new Date("2026-07-31T06:00:00Z"), // 11:30 IST
      new Date("2026-07-31T12:00:00Z") // 17:30 IST
    );
    expect(out).toEqual([{ day: "2026-07-31", seconds: 6 * 3600 }]);
  });

  it("splits a session that crosses local midnight", () => {
    const out = splitByTzDay(
      new Date("2026-07-30T17:30:00Z"), // 23:00 IST on the 30th
      new Date("2026-07-30T19:30:00Z") // 01:00 IST on the 31st
    );
    expect(out).toEqual([
      { day: "2026-07-30", seconds: 3600 },
      { day: "2026-07-31", seconds: 3600 },
    ]);
  });

  it("covers every day of a multi-day span without losing time", () => {
    const from = new Date("2026-07-29T10:00:00Z");
    const to = new Date("2026-08-01T10:00:00Z");
    const out = splitByTzDay(from, to);
    expect(out.map((b) => b.day)).toEqual([
      "2026-07-29",
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
    ]);
    const total = out.reduce((a, b) => a + b.seconds, 0);
    expect(total).toBe((to.getTime() - from.getTime()) / 1000);
  });

  it("returns nothing for an empty or inverted range", () => {
    const t = new Date("2026-07-31T06:00:00Z");
    expect(splitByTzDay(t, t)).toEqual([]);
    expect(splitByTzDay(t, new Date("2026-07-31T05:00:00Z"))).toEqual([]);
  });
});
