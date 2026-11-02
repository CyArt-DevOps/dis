import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageFlags } from "discord.js";

// EMS spec 2026-11-02 §4 / §8: /link and the roster buttons + modals. Replies are ephemeral, credentials are
// never logged, and with no roster loaded /link falls back to the email-code flow.
const emsPost = vi.fn();
vi.mock("../src/services/emsClient.js", () => ({ emsPost: (...a: unknown[]) => emsPost(...a), integrationEnabled: () => enabled }));
let enabled = true;
const warn = vi.fn();
vi.mock("../src/core/logger.js", () => ({ logger: { warn: (...a: unknown[]) => warn(...a), info: vi.fn(), error: vi.fn() } }));

const { link } = await import("../src/commands/link.js");
const { rosterLinkHandlers } = await import("../src/interactions/rosterLink.js");
const { ROSTER_IDS } = await import("../src/services/rosterLink.js");
const { LINK_IDS } = await import("../src/services/emsLink.js");
const { EmsHttpError } = await import("../src/lib/emsErrors.js");

const USER = "100000000000000001";
const CREDS = { status: "credentials", email: "asha@example.test", password: "Xk7#abcdEF2q", portalUrl: "https://ems.cyart.io", expiresHours: 48 };
const customIds = (call: unknown) =>
  ((call as { components: { toJSON: () => { components: { custom_id: string }[] } }[] }).components ?? []).flatMap((r) => r.toJSON().components.map((c) => c.custom_id));

function slash() {
  return { user: { id: USER }, reply: vi.fn(async () => {}), deferReply: vi.fn(async () => {}), editReply: vi.fn(async () => {}) };
}
function component(kind: "button" | "modal", customId: string, fields: Record<string, string> = {}) {
  return {
    user: { id: USER },
    customId,
    isButton: () => kind === "button",
    isModalSubmit: () => kind === "modal",
    showModal: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    fields: { getTextInputValue: (k: string) => fields[k] ?? "" },
  };
}
const handlerFor = (i: ReturnType<typeof component>) => rosterLinkHandlers.find((h) => h.matches(i as never))!;

beforeEach(() => { emsPost.mockReset(); warn.mockReset(); enabled = true; });

describe("/link", () => {
  it("defers ephemerally and shows the credentials from EMS", async () => {
    emsPost.mockResolvedValue(CREDS);
    const i = slash();
    await link.execute(i as never);
    expect(i.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(emsPost).toHaveBeenCalledWith("/roster/start", { discordId: USER });
    const arg = i.editReply.mock.calls[0]![0] as { content: string };
    expect(arg.content).toContain("`Xk7#abcdEF2q`");
    expect(customIds(arg)).toEqual([]);
  });
  it("no roster loaded → the email-code flow's Link EMS account button", async () => {
    emsPost.mockResolvedValue({ status: "no_roster" });
    const i = slash();
    await link.execute(i as never);
    expect(customIds(i.editReply.mock.calls[0]![0])).toEqual([LINK_IDS.begin]);
  });
  it("medium → Verify button; not listed → I filled the form", async () => {
    emsPost.mockResolvedValueOnce({ status: "verify", triesLeft: 2 }).mockResolvedValueOnce({ status: "not_listed" });
    const a = slash(); await link.execute(a as never);
    const b = slash(); await link.execute(b as never);
    expect(customIds(a.editReply.mock.calls[0]![0])).toEqual([ROSTER_IDS.verify]);
    expect(customIds(b.editReply.mock.calls[0]![0])).toEqual([ROSTER_IDS.claim]);
  });
  it("an EMS error shows a generic message and logs only the status, never the body", async () => {
    emsPost.mockRejectedValue(new EmsHttpError(500, '{"password":"leak"}'));
    const i = slash();
    await link.execute(i as never);
    expect((i.editReply.mock.calls[0]![0] as { content: string }).content).toMatch(/isn't available/);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toEqual({ user: USER, step: "start", status: 500 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("leak");
  });
  it("integration off → plain ephemeral reply, no EMS call", async () => {
    enabled = false;
    const i = slash();
    await link.execute(i as never);
    expect(i.reply).toHaveBeenCalledWith({ content: "Linking isn't available right now.", flags: MessageFlags.Ephemeral });
    expect(emsPost).not.toHaveBeenCalled();
  });
});

describe("roster buttons and modals", () => {
  it("buttons open their modals (handler acks itself)", async () => {
    for (const [id, modalId] of [[ROSTER_IDS.verify, ROSTER_IDS.verifyModal], [ROSTER_IDS.claim, ROSTER_IDS.claimModal]] as const) {
      const i = component("button", id);
      const h = handlerFor(i);
      expect(h.ack ?? "self").toBe("self");
      await h.handle(i as never);
      expect((i.showModal.mock.calls[0]![0] as { toJSON: () => { custom_id: string } }).toJSON().custom_id).toBe(modalId);
    }
  });
  it("verify modal: deferred ephemerally by the dispatcher, sends email + phone, shows credentials", async () => {
    emsPost.mockResolvedValue(CREDS);
    const i = component("modal", ROSTER_IDS.verifyModal, { email: "asha@example.test", phone: "0001" });
    const h = handlerFor(i);
    expect(h.ack).toBe("reply");
    await h.handle(i as never);
    expect(emsPost).toHaveBeenCalledWith("/roster/verify", { discordId: USER, email: "asha@example.test", phone: "0001" });
    expect((i.editReply.mock.calls[0]![0] as { content: string }).content).toContain("Temporary password");
    expect(warn).not.toHaveBeenCalled();
  });
  it("verify modal mismatch offers the button again", async () => {
    emsPost.mockResolvedValue({ status: "mismatch", triesLeft: 1 });
    const i = component("modal", ROSTER_IDS.verifyModal, { email: "x@x.test", phone: "9999" });
    await handlerFor(i).handle(i as never);
    expect(customIds(i.editReply.mock.calls[0]![0])).toEqual([ROSTER_IDS.verify]);
  });
  it("claim modal sends name, email, phone and confirms the review", async () => {
    emsPost.mockResolvedValue({ status: "sent_for_review" });
    const i = component("modal", ROSTER_IDS.claimModal, { name: "Asha Rao", email: "asha@example.test", phone: "+91 98765 40001" });
    const h = handlerFor(i);
    expect(h.ack).toBe("reply");
    await h.handle(i as never);
    expect(emsPost).toHaveBeenCalledWith("/roster/claim", { discordId: USER, name: "Asha Rao", email: "asha@example.test", phone: "+91 98765 40001" });
    expect((i.editReply.mock.calls[0]![0] as { content: string }).content).toMatch(/Sent to HR/);
  });
  it("a failed modal call logs the step and status only", async () => {
    emsPost.mockRejectedValue(new Error("network down"));
    const i = component("modal", ROSTER_IDS.claimModal, { name: "A B", email: "a@x.test", phone: "1234" });
    await handlerFor(i).handle(i as never);
    expect(warn.mock.calls[0]![0]).toEqual({ user: USER, step: "claim", status: undefined });
  });
});
