import { describe, it, expect, vi } from "vitest";

// HG-DIS-03: the /leave Half day option builds the right modal / ticket and validates the window.
vi.mock("../src/core/db.js", () => ({ prisma: {} }));
vi.mock("../src/config/loader.js", () => ({
  org: { timezone: "Asia/Kolkata", categories: { hr: { name: "HR" } }, attendancePolicy: { trackingStartsOn: "2026-01-01" } },
}));

const L = await import("../src/services/leave.js");

const NOW = new Date("2026-11-07T06:00:00Z"); // 7 Nov 2026, 11:30 IST

describe("Half day in /leave", () => {
  it("is a leave type in the picker and the slash command, not in the direct grant", () => {
    expect(L.LEAVE_TYPE_CHOICES.map((c) => c.value)).toContain("half_day");
    const select = L.leaveTypeSelect().toJSON() as { components: { options: { value: string }[] }[] };
    expect(select.components[0]!.options.map((o) => o.value)).toContain("half_day");
  });
  it("start picker offers 11:30–16:00 and shows each end", () => {
    const row = L.halfStartSelect().toJSON() as { components: { custom_id: string; options: { label: string; value: string }[] }[] };
    const opts = row.components[0]!.options;
    expect(row.components[0]!.custom_id).toBe(L.LEAVE_IDS.halfStart);
    expect(opts.map((o) => o.value)).toEqual(["11:30", "12:00", "12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00"]);
    expect(opts.find((o) => o.value === "13:00")!.label).toBe("13:00 – 16:00");
    expect(opts.at(-1)!.label).toBe("16:00 – 19:00");
  });
  it("modal asks for one date and the reason, titled with the window", () => {
    const m = L.leaveModal("half_day", "13:00").toJSON() as { custom_id: string; title: string; components: { components: { custom_id: string }[] }[] };
    expect(m.title).toBe("Half-day leave 13:00–16:00");
    expect(m.custom_id).toBe("leave:modal:half_day:1300");
    expect(m.components.map((r) => r.components[0]!.custom_id)).toEqual(["start_date", "reason"]);
    expect(L.halfStartFromId("1300")).toBe("13:00");
    expect(L.halfStartFromId("13:00")).toBeNull();
  });
  it("a valid request becomes the 3 h window on that date", () => {
    const r = L.checkHalfDayRequest("09/11/2026", "09/11/2026", "13:00", NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.half).toEqual({ start: "13:00", end: "16:00" });
    expect(r.startAt.toISOString()).toBe("2026-11-09T07:30:00.000Z");
    expect(r.endAt.toISOString()).toBe("2026-11-09T10:30:00.000Z");
  });
  it("rejects a range with a clear message", () => {
    const r = L.checkHalfDayRequest("09/11/2026", "10/11/2026", "13:00", NOW);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/single date/) });
  });
  it("rejects a window outside 11:30–19:00, a missing start, and a window already over", () => {
    expect(L.checkHalfDayRequest("09/11/2026", null, "11:00", NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/11:30/) });
    expect(L.checkHalfDayRequest("09/11/2026", null, "16:30", NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/19:00/) });
    expect(L.checkHalfDayRequest("09/11/2026", null, null, NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/start time/) });
    expect(L.checkHalfDayRequest("31/02/2026", null, "13:00", NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/DD\/MM\/YYYY/) });
    expect(L.checkHalfDayRequest("06/11/2026", null, "13:00", NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/passed/) });
  });
  it("HR ticket is titled with the actual times and shows the date and window", () => {
    const startAt = new Date("2026-11-09T07:30:00Z");
    const endAt = new Date("2026-11-09T10:30:00Z");
    const half = { start: "13:00", end: "16:00" };
    const title = L.leaveTitle({ type: "half_day", halfDay: true, halfStart: "13:00", halfEnd: "16:00" });
    expect(title).toBe("Half-day leave 13:00–16:00");
    const e = L.leaveTicketEmbed(42, "210000000000000021", title, startAt, endAt, "Doctor", half).toJSON();
    expect(e.title).toBe("Half-day leave 13:00–16:00 · Request #42");
    expect(e.fields!.find((f) => f.name === "Window (IST)")!.value).toBe("13:00–16:00");
    expect(L.leaveSpan(startAt, endAt, half)).toMatch(/13:00–16:00$/);
  });
  it("a full-day leave keeps its type label", () => {
    expect(L.leaveTitle({ type: "casual", halfDay: false })).toBe("Casual Leave");
  });
});
