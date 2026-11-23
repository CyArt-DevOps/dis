import { describe, it, expect, vi } from "vitest";

// A reason longer than Discord's 1024-char embed field made addFields throw
// after the channel was created, leaving an empty leave ticket (prod #682, #724).
vi.mock("../src/core/db.js", () => ({ prisma: {} }));
vi.mock("../src/config/loader.js", () => ({
  org: { timezone: "Asia/Kolkata", categories: { hr: { name: "HR" } }, attendancePolicy: { trackingStartsOn: "2026-01-01" } },
}));

const L = await import("../src/services/leave.js");

const startAt = new Date("2026-11-24T06:00:00Z");
const endAt = new Date("2026-11-28T13:30:00Z");
const LONG = "Semester exams: ".concat("Paper X on day Y. ".repeat(250)); // ~4500 chars

describe("long leave reason", () => {
  it("ticket embed builds and keeps the Reason field within 1024 chars", () => {
    const e = L.leaveTicketEmbed(724, "210000000000000021", "University Examination Leave", startAt, endAt, LONG).toJSON();
    const reason = e.fields!.find((f) => f.name === "Reason")!.value;
    expect(reason.length).toBeLessThanOrEqual(1024);
    expect(reason).toMatch(/full reason below/);
  });
  it("half-day embed is clipped too", () => {
    const half = { start: "13:00", end: "16:00" };
    const e = L.leaveTicketEmbed(1, "210000000000000021", "Half-day leave 13:00–16:00", startAt, endAt, LONG, half).toJSON();
    expect(e.fields!.find((f) => f.name === "Reason")!.value.length).toBeLessThanOrEqual(1024);
  });
  it("a short reason is shown as is", () => {
    const e = L.leaveTicketEmbed(2, "210000000000000021", "Casual Leave", startAt, endAt, "Family function").toJSON();
    expect(e.fields!.find((f) => f.name === "Reason")!.value).toBe("Family function");
  });
  it("full reason is split into messages of at most 2000 chars with nothing lost", () => {
    const parts = L.fullReasonMessages(LONG);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(2000);
    expect(parts.join("")).toContain(LONG.slice(-200));
    expect(L.fullReasonMessages("short")).toEqual([]);
  });
  it("clipField never exceeds the limit", () => {
    expect(L.clipField("a".repeat(5000), 100).length).toBeLessThanOrEqual(100);
    expect(L.clipField("", 100)).toBe("—");
  });
});
