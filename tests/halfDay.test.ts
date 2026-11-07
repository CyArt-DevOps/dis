import { describe, it, expect } from "vitest";
import {
  HALF_DAY_STARTS,
  halfDayEnd,
  halfDayLabel,
  halfWindowError,
  halfWindowUtc,
  halfDayRules,
  leaveCoversAt,
  leaveLabel,
} from "../src/lib/halfDay.js";

// HG-DIS-01 / HG-DIS-03: half-day rules shared by /leave, the HR sync and the attendance checks.
describe("half-day window", () => {
  it("offers starts 11:30 to 16:00 in 30-minute steps", () => {
    expect(HALF_DAY_STARTS).toEqual(["11:30", "12:00", "12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00"]);
  });
  it("ends 3 h after the start", () => {
    expect(halfDayEnd("13:00")).toBe("16:00");
    expect(halfDayEnd("11:30")).toBe("14:30");
    expect(halfDayEnd("16:00")).toBe("19:00");
    expect(halfDayEnd("nope")).toBeNull();
  });
  it("accepts a 3 h window inside 11:30–19:00", () => {
    expect(halfWindowError("11:30", "14:30")).toBeNull();
    expect(halfWindowError("16:00", "19:00")).toBeNull();
  });
  it("rejects a window outside 11:30–19:00 or not 3 h long", () => {
    expect(halfWindowError("11:00", "14:00")).toMatch(/11:30/);
    expect(halfWindowError("16:30", "19:30")).toMatch(/19:00/);
    expect(halfWindowError("13:00", "15:00")).toMatch(/3 hours/);
    expect(halfWindowError("1pm", "16:00")).toMatch(/HH:MM/);
    expect(halfWindowError(undefined, undefined)).toMatch(/HH:MM/);
  });
  it("labels it with the actual times", () => {
    expect(halfDayLabel("13:00", "16:00")).toBe("Half-day leave 13:00–16:00");
    expect(leaveLabel({ type: "casual", halfDay: true, halfStart: "13:00", halfEnd: "16:00" }, "Casual Leave")).toBe("Half-day leave 13:00–16:00");
    expect(leaveLabel({ type: "casual", halfDay: false, halfStart: null, halfEnd: null }, "Casual Leave")).toBe("Casual Leave");
  });
  it("turns the IST window into UTC instants", () => {
    const w = halfWindowUtc("2026-11-09", "13:00", "16:00");
    expect(w.start.toISOString()).toBe("2026-11-09T07:30:00.000Z");
    expect(w.end.toISOString()).toBe("2026-11-09T10:30:00.000Z");
  });
});

describe("leaveCoversAt", () => {
  const full = { startAt: new Date("2026-11-08T18:30:00Z"), endAt: new Date("2026-11-09T18:29:59Z"), approvedDays: null, halfDay: false, halfStart: null, halfEnd: null };
  const half = { ...full, approvedDays: "2026-11-09", halfDay: true, halfStart: "13:00", halfEnd: "16:00" };
  it("a full day covers the whole day", () => {
    expect(leaveCoversAt(full, new Date("2026-11-09T04:30:00Z"))).toBe(true);
  });
  it("a half day covers only its window", () => {
    expect(leaveCoversAt(half, new Date("2026-11-09T04:30:00Z"))).toBe(false); // 10:00 IST
    expect(leaveCoversAt(half, new Date("2026-11-09T07:30:00Z"))).toBe(true); // 13:00 IST
    expect(leaveCoversAt(half, new Date("2026-11-09T10:00:00Z"))).toBe(true); // 15:30 IST
    expect(leaveCoversAt(half, new Date("2026-11-09T10:30:00Z"))).toBe(false); // 16:00 IST, window over
    expect(leaveCoversAt(half, new Date("2026-11-10T08:00:00Z"))).toBe(false); // next day
  });
});

describe("halfDayRules", () => {
  const policy = { minHours: 5.5, loginBy: "14:00" };
  it("drops the target by 3 h", () => {
    expect(halfDayRules(policy, { start: "13:00", end: "16:00" }).requiredSeconds).toBe(2.5 * 3600);
  });
  it("moves the cutoff to the window end only when the window starts at or before it", () => {
    expect(halfDayRules(policy, { start: "14:00", end: "17:00" }).loginBy).toBe("17:00");
    expect(halfDayRules(policy, { start: "11:30", end: "14:30" }).loginBy).toBe("14:30");
    expect(halfDayRules(policy, { start: "14:30", end: "17:30" }).loginBy).toBe("14:00");
  });
  it("moves the cutoff like EMS dayExpectations: window start at or before 14:00, whatever the configured cutoff", () => {
    const early = { minHours: 5.5, loginBy: "11:00" };
    expect(halfDayRules(early, { start: "13:00", end: "16:00" }).loginBy).toBe("16:00");
    const late = { minHours: 5.5, loginBy: "18:00" };
    expect(halfDayRules(late, { start: "14:30", end: "17:30" }).loginBy).toBe("18:00");
    expect(halfDayRules(late, { start: "14:00", end: "17:00" }).loginBy).toBe("17:00");
  });
});
