import { describe, it, expect, vi, beforeEach } from "vitest";

// EMS spec 2026-11-17 §5 / §8: the reset modal submit. Deferred ephemerally by the dispatcher, sends the trimmed
// email, renders each EMS status privately, and never logs the reply or the error body.
const emsPost = vi.fn();
vi.mock("../src/services/emsClient.js", () => ({ emsPost: (...a: unknown[]) => emsPost(...a), integrationEnabled: () => true }));
const warn = vi.fn();
vi.mock("../src/core/logger.js", () => ({ logger: { warn: (...a: unknown[]) => warn(...a), info: vi.fn(), error: vi.fn() } }));

const { passwordResetHandlers } = await import("../src/interactions/passwordReset.js");
const { RESET_IDS } = await import("../src/services/passwordReset.js");
const { EmsHttpError } = await import("../src/lib/emsErrors.js");
const { EmsCoolingDown } = await import("../src/lib/emsBreaker.js");

const USER = "100000000000000001";
function modal(email: string, customId: string = RESET_IDS.modal) {
  return {
    user: { id: USER },
    customId,
    isButton: () => false,
    isModalSubmit: () => true,
    editReply: vi.fn(async () => {}),
    fields: { getTextInputValue: (k: string) => (k === RESET_IDS.email ? email : "") },
  };
}
const handlerFor = (i: ReturnType<typeof modal>) => passwordResetHandlers.find((h) => h.matches(i as never));
const content = (i: ReturnType<typeof modal>) => (i.editReply.mock.calls[0]![0] as { content: string }).content;

beforeEach(() => { emsPost.mockReset(); warn.mockReset(); });

describe("reset modal submit", () => {
  it("matches only the reset modal, deferred as an ephemeral reply by the dispatcher", () => {
    const h = handlerFor(modal("a@x.test"))!;
    expect(h.ack).toBe("reply");
    expect(handlerFor(modal("a@x.test", "emsroster:verifymodal"))).toBeUndefined();
  });
  it("sends the trimmed email and shows the reset credentials", async () => {
    emsPost.mockResolvedValue({ status: "credentials", email: "asha@example.test", password: "Xk7#abcdEF2q", portalUrl: "https://ems.cyart.io", expiresHours: 48, reset: true });
    const i = modal("  asha@example.test  ");
    await handlerFor(i)!.handle(i as never);
    expect(emsPost).toHaveBeenCalledWith("/password/reset", { discordId: USER, email: "asha@example.test" });
    expect(content(i)).toMatch(/^Your portal password was reset\. You have been signed out everywhere\./);
    expect(content(i)).toContain("`Xk7#abcdEF2q`");
    expect(warn).not.toHaveBeenCalled();
  });
  it("renders each refusal with its §5 text", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ status: "reset_limit" }, /twice in the last 24 hours/],
      [{ status: "reset_locked" }, /Too many wrong emails/],
      [{ status: "not_linked" }, /Run \/link first/],
      [{ status: "staff_account" }, /reset by HR or the Super Admin/],
      [{ status: "account_blocked" }, /deactivated/],
      [{ status: "email_mismatch", triesLeft: 2 }, /doesn't match .* 2 tries left today\./],
    ];
    for (const [reply, text] of cases) {
      emsPost.mockResolvedValueOnce(reply);
      const i = modal("asha@example.test");
      await handlerFor(i)!.handle(i as never);
      expect(content(i)).toMatch(text);
    }
  });
  it("a value that is not an email is refused locally, without calling EMS", async () => {
    const i = modal("not an email");
    await handlerFor(i)!.handle(i as never);
    expect(emsPost).not.toHaveBeenCalled();
    expect(content(i)).toBe("That doesn't look like an email address. Run /reset-password again and type your portal email.");
  });
  it("an email over 254 characters is refused locally with the validation message, without calling EMS", async () => {
    const i = modal(`${"a".repeat(250)}@x.co`);
    await handlerFor(i)!.handle(i as never);
    expect(emsPost).not.toHaveBeenCalled();
    expect(content(i)).toBe("That doesn't look like an email address. Run /reset-password again and type your portal email.");
  });
  it("while EMS calls are paused it says when to run /reset-password again", async () => {
    emsPost.mockRejectedValue(new EmsCoolingDown(new Date("2026-11-16T08:30:00Z")));
    const i = modal("asha@example.test");
    await handlerFor(i)!.handle(i as never);
    expect(content(i)).toMatch(/busy right now\. Please run \/reset-password again after <t:1794817800:t>/);
    expect(warn).not.toHaveBeenCalled();
  });
  it("an EMS error shows the generic message and logs step + status only, never the body", async () => {
    emsPost.mockRejectedValue(new EmsHttpError(500, '{"password":"leak"}'));
    const i = modal("asha@example.test");
    await handlerFor(i)!.handle(i as never);
    expect(content(i)).toBe("Password reset isn't available right now. Please try again later.");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ user: USER, step: "reset", status: 500, reason: "http_500" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("leak");
  });
});
