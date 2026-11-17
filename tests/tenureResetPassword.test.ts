import { describe, expect, it } from "vitest";
import { TENURE_DESCRIPTION } from "../src/services/tenure.js";

// EMS spec 2026-11-17 D6: the EMS access announcement sends interns who forgot their password to /reset-password.
describe("tenure announcement: forgotten password", () => {
  it("points interns to /reset-password and staff to HR", () => {
    expect(TENURE_DESCRIPTION).toContain(
      "• **\"Already linked\"**, or you have forgotten your password: Interns, type **`/reset-password`** in the CyArt Discord server. Staff, please contact HR."
    );
    expect(TENURE_DESCRIPTION).not.toContain("forgotten your password: Please contact HR.");
    expect(TENURE_DESCRIPTION.length).toBeLessThanOrEqual(4096);
  });
});
