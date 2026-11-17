import { describe, it, expect, vi } from "vitest";

// EMS spec 2026-11-17 §5: the reply texts for /reset-password, and /link now points at it.
vi.mock("../src/services/emsClient.js", () => ({ emsPost: vi.fn() }));
const R = await import("../src/services/rosterLink.js");

describe("rosterMessage for /reset-password", () => {
  it("credentials with reset: true lead with the reset line, then the usual login", () => {
    const m = R.rosterMessage({ status: "credentials", email: "asha@example.test", password: "Xk7#abcdEF2q", portalUrl: "https://ems.cyart.io", expiresHours: 48, reset: true });
    expect(m.split("\n")[0]).toBe("Your portal password was reset. You have been signed out everywhere.");
    expect(m).toContain("**Your CyArt portal login**");
    expect(m).toContain("Temporary password: `Xk7#abcdEF2q`");
    expect(m).toMatch(/expires in 48 hours/);
    expect(m).not.toMatch(/new temporary password replaces/);
  });
  it("has the spec text for every refusal", () => {
    expect(R.rosterMessage({ status: "reset_limit" })).toBe("You've reset your password twice in the last 24 hours. Try again tomorrow or open an HR ticket.");
    expect(R.rosterMessage({ status: "reset_locked" })).toBe("Too many wrong emails. Try again in 24 hours or open an HR ticket.");
    expect(R.rosterMessage({ status: "not_linked" })).toBe("Your Discord isn't linked to a portal account yet. Run /link first.");
    expect(R.rosterMessage({ status: "staff_account" })).toBe("Staff accounts are reset by HR or the Super Admin. Open an HR ticket.");
    expect(R.rosterMessage({ status: "account_blocked" })).toBe("This portal account is deactivated. Contact HR.");
  });
  it("email_mismatch says how many tries are left today", () => {
    const base = "That email doesn't match the portal account linked to your Discord.";
    expect(R.rosterMessage({ status: "email_mismatch", triesLeft: 2 })).toBe(`${base} 2 tries left today.`);
    expect(R.rosterMessage({ status: "email_mismatch", triesLeft: 1 })).toBe(`${base} 1 try left today.`);
    expect(R.rosterMessage({ status: "email_mismatch", triesLeft: 0 })).toBe(`${base} No tries left today. Try again in 24 hours or open an HR ticket.`);
    expect(R.rosterMessage({ status: "email_mismatch" })).toBe(base);
  });
  it("busy and the generic error name the command (default /link)", () => {
    expect(R.rosterMessage({ status: "busy" })).toMatch(/Please run \/link again in about 10 minutes/);
    expect(R.rosterMessage({ status: "busy" }, { command: "/reset-password" })).toMatch(/Please run \/reset-password again in about 10 minutes/);
    expect(R.rosterMessage({ status: "error" })).toBe("Linking isn't available right now. Please try again later.");
    expect(R.rosterMessage({ status: "error" }, { command: "/reset-password" })).toBe("Password reset isn't available right now. Please try again later.");
  });
  it("an EMS reply cannot set the command: a command field in the result is ignored", () => {
    expect(R.rosterMessage({ status: "busy", command: "/evil" } as never)).toMatch(/Please run \/link again/);
    expect(R.rosterMessage({ status: "error", command: "/reset-password" } as never)).toBe("Linking isn't available right now. Please try again later.");
  });
  it("refusals carry no buttons", () => {
    for (const status of ["reset_limit", "reset_locked", "not_linked", "staff_account", "account_blocked", "email_mismatch"]) {
      expect(R.rosterComponents({ status })).toEqual([]);
    }
  });
});

describe("/link texts point to /reset-password", () => {
  it("already_linked and linked_existing", () => {
    const a = R.rosterMessage({ status: "already_linked", maskedEmail: "a***@x.test" });
    expect(a).toMatch(/Forgot your password\? Run \/reset-password\.$/);
    expect(a).not.toMatch(/Contact HR/);
    const b = R.rosterMessage({ status: "linked_existing", maskedEmail: "a***@x.test" });
    expect(b).toMatch(/forgot it\? Run \/reset-password\.$/);
    expect(b).not.toMatch(/Contact HR/);
  });
});
