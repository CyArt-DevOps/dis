import { describe, it, expect } from "vitest";
import { ackFollowUp } from "../src/lib/warnAck.js";

describe("ackFollowUp — the thank-you after an intern acknowledges a warning", () => {
  it("an hours warning reminds about the attendance rules", () => {
    expect(ackFollowUp({ id: 6, kind: "hours" }, false)).toBe(
      "Thank you. Warning #6 is acknowledged. Please make sure to follow the attendance rules from now on."
    );
  });

  it("a conduct warning reminds about the code of conduct, not attendance", () => {
    const text = ackFollowUp({ id: 6, kind: "conduct" }, false);
    expect(text).toBe("Thank you. Warning #6 is acknowledged. Please make sure to follow the code of conduct from now on.");
    expect(text).not.toMatch(/attendance/);
  });

  it("any other warning gets a neutral reminder", () => {
    for (const kind of ["other", "", null, undefined, "something-new"]) {
      const text = ackFollowUp({ id: 9, kind }, false);
      expect(text).toBe("Thank you. Warning #9 is acknowledged. Please make sure it does not happen again.");
    }
  });

  it("a late acknowledgement says so", () => {
    expect(ackFollowUp({ id: 6, kind: "conduct" }, true)).toBe(
      "Thank you. Warning #6 is acknowledged (after the deadline). Please make sure to follow the code of conduct from now on."
    );
  });
});
