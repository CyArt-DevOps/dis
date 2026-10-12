import { describe, it, expect } from "vitest";
import { parseDateTime, formatInTz } from "../src/lib/time.js";

describe("parseDateTime (IST)", () => {
  it("converts 10:00 AM IST to 04:30 UTC", () => {
    const d = parseDateTime("10/07/2026", "10:00 AM");
    expect(d?.toISOString()).toBe("2026-07-10T04:30:00.000Z");
  });

  it("handles noon and midnight", () => {
    expect(parseDateTime("01/01/2026", "12:00 PM")?.toISOString()).toBe("2026-01-01T06:30:00.000Z");
    expect(parseDateTime("01/01/2026", "12:00 AM")?.toISOString()).toBe("2025-12-31T18:30:00.000Z");
  });

  it("rejects impossible dates", () => {
    expect(parseDateTime("31/02/2026", "9:00 AM")).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(parseDateTime("2026-07-10", "10:00")).toBeNull();
    expect(parseDateTime("10/07/2026", "25:00 AM")).toBeNull();
  });

  it("round-trips through formatInTz", () => {
    const d = parseDateTime("10/07/2026", "10:00 AM")!;
    expect(formatInTz(d)).toContain("10:00");
  });
});
