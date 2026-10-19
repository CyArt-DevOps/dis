import { describe, it, expect } from "vitest";
import { isTicketsCategory, ticketsIndex } from "../src/services/ticketCategory.js";

describe("tickets overflow naming", () => {
  it("recognises the base and numbered overflow categories", () => {
    expect(ticketsIndex("TICKETS")).toBe(1);
    expect(ticketsIndex("TICKETS 2")).toBe(2);
    expect(ticketsIndex("TICKETS 12")).toBe(12);
  });
  it("ignores look-alikes", () => {
    expect(isTicketsCategory("TICKETS-OLD")).toBe(false);
    expect(isTicketsCategory("ARCHIVE")).toBe(false);
    expect(isTicketsCategory("tickets 2")).toBe(false);
    expect(isTicketsCategory("TICKETS 2a")).toBe(false);
  });
});
