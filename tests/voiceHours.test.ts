import { describe, it, expect } from "vitest";
import { realSecondsByDay } from "../src/lib/voiceHours.js";

const HOUR = 3600;
const closed = (from: string, to: string) => ({ joinedAt: new Date(from), leftAt: new Date(to), creditedUpTo: null });

describe("realSecondsByDay", () => {
  it("adds separate sessions on the same day", () => {
    const out = realSecondsByDay(
      [closed("2026-11-02T06:00:00Z", "2026-11-02T07:00:00Z"), closed("2026-11-02T08:00:00Z", "2026-11-02T09:30:00Z")],
      12 * HOUR
    );
    expect(out.get("2026-11-02")).toBe(2.5 * HOUR);
  });

  it("counts overlapping sessions once", () => {
    const out = realSecondsByDay(
      [closed("2026-11-02T06:00:00Z", "2026-11-02T08:00:00Z"), closed("2026-11-02T07:00:00Z", "2026-11-02T09:00:00Z")],
      12 * HOUR
    );
    expect(out.get("2026-11-02")).toBe(3 * HOUR);
  });

  it("splits at local (IST) midnight", () => {
    // 18:00Z to 19:00Z is 23:30 to 00:30 IST.
    const out = realSecondsByDay([closed("2026-11-02T18:00:00Z", "2026-11-02T19:00:00Z")], 12 * HOUR);
    expect(out.get("2026-11-02")).toBe(1800);
    expect(out.get("2026-11-03")).toBe(1800);
  });

  it("stops a session at the cap", () => {
    const out = realSecondsByDay([closed("2026-11-02T00:00:00Z", "2026-11-02T17:00:00Z")], 12 * HOUR);
    expect(out.get("2026-11-02")).toBe(12 * HOUR);
  });

  it("counts an open session only up to its checkpoint", () => {
    const open = { joinedAt: new Date("2026-11-02T06:00:00Z"), leftAt: null, creditedUpTo: new Date("2026-11-02T07:00:00Z") };
    expect(realSecondsByDay([open], 12 * HOUR).get("2026-11-02")).toBe(HOUR);
    const fresh = { joinedAt: new Date("2026-11-02T06:00:00Z"), leftAt: null, creditedUpTo: null };
    expect(realSecondsByDay([fresh], 12 * HOUR).size).toBe(0);
  });
});
