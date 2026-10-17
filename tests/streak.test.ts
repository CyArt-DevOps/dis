import { describe, it, expect } from "vitest";
import { shortStreak } from "../src/lib/streak.js";

const REQ = 5.5 * 3600;
const d = (day: string, status: string, hours = 0) => ({ day, status, seconds: Math.round(hours * 3600) });
const opts = (over: Partial<Parameters<typeof shortStreak>[1]> = {}) => ({
  settled: "2026-10-23",
  n: 2,
  requiredSeconds: REQ,
  covered: new Set<string>(),
  ...over,
});

describe("shortStreak", () => {
  it("flags two short working days in a row ending on the latest settled day", () => {
    const days = [d("2026-10-21", "good", 6), d("2026-10-22", "partial", 3), d("2026-10-23", "missing")];
    expect(shortStreak(days, opts())?.map((x) => x.day)).toEqual(["2026-10-22", "2026-10-23"]);
  });

  it("ignores a late-but-full day: only hours count", () => {
    const days = [d("2026-10-22", "partial", 6), d("2026-10-23", "partial", 2)];
    expect(shortStreak(days, opts())).toBeNull();
  });

  it("skips weekends, holidays and leave when deciding consecutiveness", () => {
    const days = [
      d("2026-10-16", "missing"), // Fri
      d("2026-10-17", "off"),
      d("2026-10-18", "off"),
      d("2026-10-19", "holiday"),
      d("2026-10-20", "leave"),
      d("2026-10-21", "partial", 1), // Wed
    ];
    expect(shortStreak(days, opts({ settled: "2026-10-21" }))?.map((x) => x.day)).toEqual(["2026-10-16", "2026-10-21"]);
  });

  it("needs the streak to end on the latest counted day", () => {
    const days = [d("2026-10-21", "missing"), d("2026-10-22", "missing"), d("2026-10-23", "good", 6)];
    expect(shortStreak(days, opts())).toBeNull();
  });

  it("does not warn twice for a day already covered by a warning", () => {
    const days = [d("2026-10-22", "missing"), d("2026-10-23", "missing")];
    expect(shortStreak(days, opts({ covered: new Set(["2026-10-22"]) }))).toBeNull();
  });

  it("ignores unsettled days and days before enforcement starts", () => {
    const days = [d("2026-10-22", "missing"), d("2026-10-23", "missing"), d("2026-10-24", "missing")];
    expect(shortStreak(days, opts({ settled: "2026-10-23", startsOn: "2026-10-23" }))).toBeNull();
  });
});
