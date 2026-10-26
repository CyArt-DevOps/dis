import { describe, it, expect } from "vitest";
import { startMessage, confirmMessage } from "../src/services/emsLink.js";

describe("startMessage", () => {
  it("tells the member where the code went", () => {
    // The mask's asterisks are escaped so they can't break the surrounding **bold**.
    expect(startMessage({ status: "code_sent", maskedEmail: "a***@x_y.com" })).toContain("a\\*\\*\\*@x\\_y.com");
  });
  it("explains every failure without leaking whether the email exists to HR-mismatch callers", () => {
    for (const s of ["not_found", "hr_mismatch", "already_linked", "linked_elsewhere", "discord_taken", "email_failed", "rate_limited", "weird"]) {
      expect(startMessage({ status: s }).length).toBeGreaterThan(10);
    }
    expect(startMessage({ status: "hr_mismatch" })).toMatch(/HR/);
    expect(startMessage({ status: "email_failed" })).toMatch(/couldn't send/i);
  });
});

describe("confirmMessage", () => {
  it("greets on success and guides on failure", () => {
    expect(confirmMessage({ status: "linked", name: "Dee" })).toContain("Dee");
    expect(confirmMessage({ status: "expired" })).toMatch(/expired/i);
    expect(confirmMessage({ status: "invalid" })).toMatch(/code/i);
  });
  it("handles discord_taken and linked_elsewhere like startMessage", () => {
    expect(confirmMessage({ status: "discord_taken" })).toBe(startMessage({ status: "discord_taken" }));
    expect(confirmMessage({ status: "linked_elsewhere" })).toBe(startMessage({ status: "linked_elsewhere" }));
  });
});
