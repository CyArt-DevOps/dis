import { describe, it, expect, vi, beforeEach } from "vitest";

// EMS spec 2026-11-02 §4: roster replies, buttons and modals; the three signed calls.
const emsPost = vi.fn();
vi.mock("../src/services/emsClient.js", () => ({ emsPost: (...a: unknown[]) => emsPost(...a) }));
const R = await import("../src/services/rosterLink.js");

beforeEach(() => emsPost.mockReset());

describe("roster calls", () => {
  it("post to the three roster endpoints with only what EMS needs", async () => {
    emsPost.mockResolvedValue({ status: "ok" });
    await R.startRoster("100000000000000001");
    await R.verifyRoster("100000000000000001", "a@x.test", "0001");
    await R.claimRoster("100000000000000001", "Asha Rao", "a@x.test", "+91 98765 40001");
    expect(emsPost.mock.calls).toEqual([
      ["/roster/start", { discordId: "100000000000000001" }],
      ["/roster/verify", { discordId: "100000000000000001", email: "a@x.test", phone: "0001" }],
      ["/roster/claim", { discordId: "100000000000000001", name: "Asha Rao", email: "a@x.test", phone: "+91 98765 40001" }],
    ]);
  });
});

describe("rosterMessage", () => {
  it("shows the credentials (portal, email, temp password, 48 h, set your own)", () => {
    const m = R.rosterMessage({ status: "credentials", email: "asha@example.test", password: "Xk7#abcdEF2q", portalUrl: "https://ems.cyart.io", expiresHours: 48 });
    expect(m).toContain("**Your CyArt portal login**");
    expect(m).toContain("Portal: https://ems.cyart.io · Email: `asha@example.test` · Temporary password: `Xk7#abcdEF2q`");
    expect(m).toMatch(/expires in 48 hours/);
    expect(m).toMatch(/set your own password/);
    expect(m).not.toMatch(/new temporary password/);
    expect(R.rosterMessage({ status: "credentials", email: "a@x", password: "p", reissued: true })).toMatch(/^A new temporary password replaces your old one\./);
  });
  it("escapes the masked email and the main username", () => {
    expect(R.rosterMessage({ status: "already_linked", maskedEmail: "a***@x_y.com" })).toContain("a\\*\\*\\*@x\\_y.com");
    expect(R.rosterMessage({ status: "alt_account", mainUsername: "main_acc" })).toContain("main\\_acc");
    expect(R.rosterMessage({ status: "alt_account", mainUsername: null })).toMatch(/main account\.$/);
  });
  it("has a sentence for every status, and a safe default", () => {
    for (const s of ["already_linked", "linked_existing", "existing_account", "alt_account", "verify", "mismatch", "sent_for_review", "in_review", "rejected", "not_listed", "not_allowed", "rate_limited", "discord_taken", "error"]) {
      expect(R.rosterMessage({ status: s }).length).toBeGreaterThan(20);
    }
    expect(R.rosterMessage({ status: "not_listed" })).toMatch(/not on the intern roster/);
    expect(R.rosterMessage({ status: "in_review" })).toMatch(/with HR/);
    expect(R.rosterMessage({ status: "rejected" })).toMatch(/could not confirm/);
  });
});

describe("rosterComponents and modals", () => {
  const ids = (r: { status: string }) => R.rosterComponents(r).flatMap((row) => row.toJSON().components.map((c) => (c as { custom_id: string }).custom_id));
  it("verify / mismatch → Verify my details; not_listed → I filled the form; others → none", () => {
    expect(ids({ status: "verify" })).toEqual([R.ROSTER_IDS.verify]);
    expect(ids({ status: "mismatch" })).toEqual([R.ROSTER_IDS.verify]);
    expect(ids({ status: "not_listed" })).toEqual([R.ROSTER_IDS.claim]);
    expect(ids({ status: "credentials" })).toEqual([]);
    expect(ids({ status: "in_review" })).toEqual([]);
  });
  it("the self-check modal asks for email + last 4 digits; the claim modal for name, email, phone", () => {
    const fields = (m: ReturnType<typeof R.verifyModal>) => m.toJSON().components.map((row) => (row as { components: { custom_id: string; min_length?: number; max_length?: number }[] }).components[0]!);
    const v = fields(R.verifyModal());
    expect(v.map((f) => f.custom_id)).toEqual(["email", "phone"]);
    expect([v[1]!.min_length, v[1]!.max_length]).toEqual([4, 4]);
    expect(fields(R.claimModal()).map((f) => f.custom_id)).toEqual(["name", "email", "phone"]);
    expect(R.verifyModal().toJSON().custom_id).toBe(R.ROSTER_IDS.verifyModal);
    expect(R.claimModal().toJSON().custom_id).toBe(R.ROSTER_IDS.claimModal);
  });
});
