import { describe, it, expect, vi, beforeEach } from "vitest";

// EMS spec 2026-11-17 §5: the reset modal and the signed call to EMS.
const emsPost = vi.fn();
vi.mock("../src/services/emsClient.js", () => ({ emsPost: (...a: unknown[]) => emsPost(...a) }));
const P = await import("../src/services/passwordReset.js");

beforeEach(() => emsPost.mockReset());

describe("resetPassword", () => {
  it("posts discordId + email to /password/reset and returns the EMS reply", async () => {
    emsPost.mockResolvedValue({ status: "reset_limit" });
    expect(await P.resetPassword("100000000000000001", "asha@example.test")).toEqual({ status: "reset_limit" });
    expect(emsPost.mock.calls).toEqual([["/password/reset", { discordId: "100000000000000001", email: "asha@example.test" }, 15_000]]);
  });
});

describe("resetModal", () => {
  it("one required Portal email input, max 254, under the reset modal id", () => {
    const json = P.resetModal().toJSON() as { custom_id: string; title: string; components: { components: { custom_id: string; label: string; required?: boolean; max_length?: number }[] }[] };
    expect(json.custom_id).toBe(P.RESET_IDS.modal);
    expect(json.title).toBe("Reset your portal password");
    expect(json.components).toHaveLength(1);
    const f = json.components[0]!.components[0]!;
    expect(f.custom_id).toBe(P.RESET_IDS.email);
    expect(f.label).toBe("Portal email");
    expect(f.required).toBe(true);
    expect(f.max_length).toBe(254);
  });
});

describe("EMAIL_RE", () => {
  it("accepts a plain address and rejects obvious non-emails", () => {
    expect(P.EMAIL_RE.test("asha@example.test")).toBe(true);
    for (const bad of ["", "asha", "asha@", "@example.test", "a b@example.test", "asha@example"]) expect(P.EMAIL_RE.test(bad)).toBe(false);
  });
});
