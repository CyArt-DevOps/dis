import { describe, expect, it } from "vitest";
import { TENURE_DESCRIPTION, TENURE_TITLE, normalizeDate, parseTenureForm } from "../src/services/tenure.js";

const base = { name: "Asha Rao", email: "Asha@Example.com", phone: "98765 43210", handover: "Yes", date: "14-11-2026" };

describe("tenure announcement", () => {
  it("fits a Discord embed and carries the tenure point", () => {
    expect(TENURE_DESCRIPTION.length).toBeLessThanOrEqual(4096);
    expect(TENURE_TITLE.length).toBeLessThanOrEqual(256);
    expect(TENURE_DESCRIPTION).toContain("If your internship tenure is complete");
    expect(TENURE_DESCRIPTION).toContain("/link");
  });
});

describe("normalizeDate", () => {
  it("accepts DD-MM-YYYY, DD/MM/YYYY and YYYY-MM-DD", () => {
    expect(normalizeDate("14-11-2026")).toBe("2026-11-14");
    expect(normalizeDate("4/1/2026")).toBe("2026-01-04");
    expect(normalizeDate("2026-11-14")).toBe("2026-11-14");
  });
  it("rejects impossible dates and junk", () => {
    expect(normalizeDate("31-02-2026")).toBeNull();
    expect(normalizeDate("yesterday")).toBeNull();
    expect(normalizeDate("14-11-1999")).toBeNull();
  });
});

describe("parseTenureForm", () => {
  it("normalises a valid form", () => {
    const r = parseTenureForm(base);
    expect(r).toEqual({ ok: true, value: { name: "Asha Rao", email: "asha@example.com", phone: "98765 43210", handoverDone: true, handoverDate: "2026-11-14" } });
  });
  it("keeps a plain digit phone as is", () => {
    const r = parseTenureForm({ ...base, phone: "9876543210" });
    expect(r.ok && r.value.phone).toBe("9876543210");
  });
  it("needs a date when handover is done", () => {
    const r = parseTenureForm({ ...base, date: "" });
    expect(r.ok).toBe(false);
  });
  it("allows no date when handover is not done", () => {
    const r = parseTenureForm({ ...base, handover: "no", date: "" });
    expect(r).toMatchObject({ ok: true, value: { handoverDone: false, handoverDate: null } });
  });
  it("rejects bad email, phone, handover answer and date", () => {
    expect(parseTenureForm({ ...base, email: "asha@" }).ok).toBe(false);
    expect(parseTenureForm({ ...base, phone: "12345" }).ok).toBe(false);
    expect(parseTenureForm({ ...base, phone: "98765abc10" }).ok).toBe(false);
    expect(parseTenureForm({ ...base, handover: "maybe" }).ok).toBe(false);
    expect(parseTenureForm({ ...base, date: "32-11-2026" }).ok).toBe(false);
    expect(parseTenureForm({ ...base, name: " " }).ok).toBe(false);
  });
});
